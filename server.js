import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Kroger token cache
let krogerToken = { value: null, expiresAt: 0 };

async function getKrogerToken() {
  if (krogerToken.value && Date.now() < krogerToken.expiresAt - 60_000) {
    return krogerToken.value;
  }
  const credentials = Buffer.from(
    `${process.env.KROGER_CLIENT_ID}:${process.env.KROGER_CLIENT_SECRET}`
  ).toString('base64');
  const res = await fetch('https://api.kroger.com/v1/connect/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=product.compact',
  });
  if (!res.ok) throw new Error(`Kroger token error: ${res.status}`);
  const data = await res.json();
  krogerToken = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return krogerToken.value;
}

// POST /api/chat — parse natural language into a grocery list via Claude
app.post('/api/chat', async (req, res) => {
  const { userMessage, conversationHistory = [] } = req.body;
  if (!userMessage) return res.status(400).json({ error: 'userMessage required' });

  const tool = {
    name: 'parse_grocery_list',
    description:
      'Parse the user\'s request into a structured grocery list with clarifying questions if needed.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Human-readable item name' },
              quantity: { type: 'number' },
              unit: { type: 'string', description: 'e.g. cases, oz, lbs, each' },
              searchQuery: { type: 'string', description: 'Best Kroger search term for this item' },
            },
            required: ['name', 'quantity', 'unit', 'searchQuery'],
          },
        },
        assumptions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Brief notes on assumptions made (e.g. "Added Key Lime and Pamplemousse LaCroix since no flavor was specified"). Max 4.',
        },
      },
      required: ['items', 'assumptions'],
    },
  };

  const messages = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `You are GooberEats, a friendly AI grocery shopping assistant.
When the user describes what they need, parse it into a structured grocery list and make smart assumptions rather than asking questions.
- Infer ingredients for dish names (e.g. "lasagna" → lasagna noodles, ricotta, mozzarella, marinara sauce, ground beef — assume meat unless told otherwise)
- Use realistic grocery quantities (1 box, 2 lbs, 4 cases, etc.)
- Make assumptions for ambiguous items and document them briefly:
  * Unspecified flavors (e.g. LaCroix) → pick the 2-3 most popular (Key Lime, Pamplemousse, Coconut) as separate items
  * Unspecified type (e.g. cold brew) → pick the most common format (ready-to-drink)
  * Unspecified brand → choose a widely available option
- Keep assumptions short and friendly (e.g. "Added Key Lime and Pamplemousse LaCroix — let me know if you'd like different flavors")
- For the searchQuery field, use the most effective search term (e.g. "lacroix key lime sparkling water" not just "lacroix")
Always call the parse_grocery_list tool.`,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'parse_grocery_list' },
      messages,
    });

    const toolUse = response.content.find((b) => b.type === 'tool_use');
    if (!toolUse) throw new Error('Claude did not call the tool');

    const result = toolUse.input;
    // normalize: accept either 'assumptions' or legacy 'clarifyingQuestions' key
    if (!result.assumptions) result.assumptions = result.clarifyingQuestions || [];
    res.json(result);
  } catch (err) {
    console.error('Claude error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products — search Kroger product catalog
app.get('/api/products', async (req, res) => {
  const { q, locationId } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });

  try {
    const token = await getKrogerToken();
    const params = new URLSearchParams({ 'filter.term': q, 'filter.limit': '8' });
    if (locationId) params.set('filter.locationId', locationId);

    const krogerRes = await fetch(
      `https://api.kroger.com/v1/products?${params}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    if (!krogerRes.ok) throw new Error(`Kroger products error: ${krogerRes.status}`);

    const data = await krogerRes.json();
    const products = (data.data || []).map((p) => {
      const priceInfo = p.items?.[0]?.price;
      const imageUrl =
        p.images?.find((img) => img.perspective === 'front')?.sizes?.find((s) => s.size === 'medium')?.url ||
        p.images?.[0]?.sizes?.[0]?.url ||
        null;
      return {
        productId: p.productId,
        name: p.description,
        brand: p.brand || '',
        size: p.items?.[0]?.size || '',
        price: priceInfo?.regular ?? priceInfo?.promo ?? null,
        imageUrl,
        inStock: p.items?.[0]?.fulfillment?.inStore ?? true,
      };
    });

    res.json(products);
  } catch (err) {
    console.error('Kroger products error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trending — pre-fetched popular products (30-min server cache)
const TRENDING_TERMS = [
  'banana', 'apple', 'doritos chips', 'chicken thighs',
  'cupcakes', 'lacroix sparkling water', 'wonder bread', 'eggs',
  'whole milk', 'tropicana orange juice',
];
let trendingCache = { data: null, expiresAt: 0 };

app.get('/api/trending', async (req, res) => {
  if (trendingCache.data && Date.now() < trendingCache.expiresAt) {
    return res.json(trendingCache.data);
  }
  try {
    const token = await getKrogerToken();
    const results = await Promise.all(
      TRENDING_TERMS.map(term =>
        fetch(`https://api.kroger.com/v1/products?${new URLSearchParams({ 'filter.term': term, 'filter.limit': '1' })}`,
          { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
          .then(r => r.json())
          .then(data => {
            const p = data.data?.[0];
            if (!p) return null;
            const priceInfo = p.items?.[0]?.price;
            const imageUrl =
              p.images?.find(img => img.perspective === 'front')?.sizes?.find(s => s.size === 'medium')?.url ||
              p.images?.[0]?.sizes?.[0]?.url || null;
            return {
              productId: p.productId,
              name: p.description,
              brand: p.brand || '',
              size: p.items?.[0]?.size || '',
              price: priceInfo?.regular ?? priceInfo?.promo ?? null,
              imageUrl,
              inStock: p.items?.[0]?.fulfillment?.inStore ?? true,
            };
          })
          .catch(() => null)
      )
    );
    const data = results.filter(Boolean);
    trendingCache = { data, expiresAt: Date.now() + 30 * 60 * 1000 };
    res.json(data);
  } catch (err) {
    console.error('Trending error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/locations — find nearby Kroger stores by zip
app.get('/api/locations', async (req, res) => {
  const { zip } = req.query;
  if (!zip) return res.status(400).json({ error: 'zip required' });

  try {
    const token = await getKrogerToken();
    const params = new URLSearchParams({
      'filter.zipCode.near': zip,
      'filter.limit': '5',
      'filter.chain': 'KROGER',
    });

    const krogerRes = await fetch(
      `https://api.kroger.com/v1/locations?${params}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    if (!krogerRes.ok) throw new Error(`Kroger locations error: ${krogerRes.status}`);

    const data = await krogerRes.json();
    const locations = (data.data || []).map((l) => ({
      locationId: l.locationId,
      name: l.name,
      address: l.address?.addressLine1,
      city: l.address?.city,
    }));

    res.json(locations);
  } catch (err) {
    console.error('Kroger locations error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GooberEats running at http://localhost:${PORT}`));
