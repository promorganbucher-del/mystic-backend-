const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const STORE = '4274e2-4b.myshopify.com';
const TOKEN = process.env.SHOPIFY_TOKEN;
const PORT = process.env.PORT || 3000;
const API_VERSION = '2024-01';

if (!TOKEN) console.warn('[WARN] SHOPIFY_TOKEN env variable not set');

// ─── Shopify helper ───────────────────────────────────────────────────────────

async function shopify(endpoint) {
  const url = `https://${STORE}/admin/api/${API_VERSION}/${endpoint}`;
  const res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify ${res.status}: ${body}`);
  }
  return res.json();
}

// Paginate through all pages (Shopify returns max 250 per page)
async function shopifyAll(resource, params = '') {
  let items = [];
  let page = 1;
  while (true) {
    const sep = params ? '&' : '?';
    const data = await shopify(`${resource}.json?limit=250${params ? sep + params : ''}&page=${page}`);
    const key = Object.keys(data)[0];
    const batch = data[key];
    items = items.concat(batch);
    if (batch.length < 250) break;
    page++;
  }
  return items;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', store: STORE, token_set: !!TOKEN });
});

// GET /api/products — all active products + variants + inventory
app.get('/api/products', async (req, res) => {
  try {
    const products = await shopifyAll('products', 'status=active');

    const result = products.map(p => ({
      shopify_id: p.id,
      title: p.title,
      handle: p.handle,
      image: p.images?.[0]?.src || null,
      variants: p.variants.map(v => ({
        shopify_variant_id: v.id,
        shopify_inventory_item_id: v.inventory_item_id,
        sku: v.sku || `${p.handle}-${v.title.toLowerCase().replace(/\s/g, '-')}`,
        title: v.title,
        price: parseFloat(v.price),
        stock: v.inventory_quantity ?? 0
      }))
    }));

    res.json({ products: result, count: result.length, fetched_at: new Date().toISOString() });
  } catch (err) {
    console.error('[/api/products]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders?days=30 — sales velocity per SKU
app.get('/api/orders', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceISO = since.toISOString();

    const orders = await shopifyAll('orders',
      `status=any&financial_status=paid&created_at_min=${sinceISO}&fulfillment_status=any`
    );

    // Aggregate quantity sold per SKU
    const sales = {}; // { sku: { qty, variant_id, title } }
    orders.forEach(order => {
      order.line_items.forEach(item => {
        const sku = item.sku || String(item.variant_id);
        if (!sales[sku]) {
          sales[sku] = { qty: 0, variant_id: item.variant_id, title: item.title, variant_title: item.variant_title };
        }
        sales[sku].qty += item.quantity;
      });
    });

    // Compute velocity (units/day)
    const velocity = {};
    Object.entries(sales).forEach(([sku, data]) => {
      velocity[sku] = {
        qty_sold: data.qty,
        units_per_day: parseFloat((data.qty / days).toFixed(3)),
        title: data.title,
        variant_title: data.variant_title
      };
    });

    res.json({
      velocity,
      order_count: orders.length,
      days_analyzed: days,
      period_start: sinceISO,
      fetched_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('[/api/orders]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sync — products + velocity in one call (used by app on load)
app.get('/api/sync', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;

    // Run both in parallel
    const [productsRes, ordersRes] = await Promise.all([
      (async () => {
        const products = await shopifyAll('products', 'status=active');
        return products.map(p => ({
          shopify_id: p.id,
          title: p.title,
          handle: p.handle,
          image: p.images?.[0]?.src || null,
          variants: p.variants.map(v => ({
            shopify_variant_id: v.id,
            shopify_inventory_item_id: v.inventory_item_id,
            sku: v.sku || `${p.handle}-${v.title.toLowerCase().replace(/\s/g, '-')}`,
            title: v.title,
            price: parseFloat(v.price),
            stock: v.inventory_quantity ?? 0
          }))
        }));
      })(),
      (async () => {
        const since = new Date();
        since.setDate(since.getDate() - days);
        const orders = await shopifyAll('orders',
          `status=any&financial_status=paid&created_at_min=${since.toISOString()}`
        );
        const sales = {};
        const market = {}; // { country_code: { qty, revenue } }
        orders.forEach(order => {
          // Velocity per SKU
          order.line_items.forEach(item => {
            const sku = item.sku || String(item.variant_id);
            if (!sales[sku]) sales[sku] = { qty: 0 };
            sales[sku].qty += item.quantity;
          });
          // Market breakdown
          const country = order.billing_address?.country_code || order.shipping_address?.country_code || 'XX';
          if (!market[country]) market[country] = { qty: 0, revenue: 0 };
          market[country].qty += 1;
          market[country].revenue += parseFloat(order.total_price || 0);
        });
        const velocity = {};
        Object.entries(sales).forEach(([sku, d]) => {
          velocity[sku] = parseFloat((d.qty / days).toFixed(3));
        });
        return { velocity, order_count: orders.length, market_breakdown: market };
      })()
    ]);

    res.json({
      products: productsRes,
      velocity: ordersRes.velocity,
      market_breakdown: ordersRes.market_breakdown,
      order_count: ordersRes.order_count,
      days_analyzed: days,
      synced_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('[/api/sync]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✓ Mystic backend running on port ${PORT}`);
  console.log(`  Store : ${STORE}`);
  console.log(`  Token : ${TOKEN ? '✓ set' : '✗ MISSING'}`);
});
