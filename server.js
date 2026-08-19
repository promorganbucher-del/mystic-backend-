const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const STORE = '4274e2-4b.myshopify.com';
const PORT = process.env.PORT || 3000;
const API_VERSION = '2025-10';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '61264f971b9546b1a3fd628dbb25d57e';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

let ACCESS_TOKEN = process.env.SHOPIFY_TOKEN || null;

console.log(`✓ Mystic backend starting`);
console.log(`  Store       : ${STORE}`);
console.log(`  API version : ${API_VERSION}`);
console.log(`  Token       : ${ACCESS_TOKEN ? '✓ set' : '✗ MISSING'}`);

// ─── Paginated Shopify fetch ──────────────────────────────────────────────────
async function shopifyAll(resource, params = '') {
  let items = [];
  let url = `https://${STORE}/admin/api/${API_VERSION}/${resource}.json?limit=250${params ? '&' + params : ''}`;

  while (url) {
    const res = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify ${res.status}: ${body}`);
    }
    const data = await res.json();
    const key = Object.keys(data)[0];
    items = items.concat(data[key]);

    const link = res.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return items;
}

// ─── OAuth ───────────────────────────────────────────────────────────────────
app.get('/oauth/start', (req, res) => {
  const url = `https://${STORE}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=read_products,read_orders,read_all_orders&redirect_uri=https://${req.headers.host}/oauth/callback&state=mystic123`;
  res.redirect(url);
});

app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const r = await fetch(`https://${STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code })
    });
    const data = await r.json();
    if (data.access_token) {
      ACCESS_TOKEN = data.access_token;
      res.send(`<h2>✓ Connected!</h2><p>Add to Railway as SHOPIFY_TOKEN: <strong>${ACCESS_TOKEN}</strong></p>`);
    } else {
      res.status(400).json(data);
    }
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', store: STORE, api_version: API_VERSION, token_set: !!ACCESS_TOKEN });
});

// ─── Products ─────────────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const products = await shopifyAll('products', 'status=active');
    const result = products.map(p => ({
      shopify_id: p.id,
      title: p.title,
      handle: p.handle,
      image: p.images?.[0]?.src || null,
      product_type: p.product_type || '',
      variants: p.variants.map(v => ({
        shopify_variant_id: v.id,
        shopify_inventory_item_id: v.inventory_item_id,
        sku: v.sku || `${p.handle}-${v.title.toLowerCase().replace(/\s/g,'-')}`,
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

// ─── Orders ───────────────────────────────────────────────────────────────────
// NOTE: financial_status removed from query params (deprecated in 2024-04+)
// Filtering paid orders is done in JS on the response
app.get('/api/orders', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const orders = await shopifyAll('orders', `status=any&created_at_min=${since.toISOString()}`);

    const sales = {};
    orders.forEach(order => {
      const paid = ['paid','partially_paid'].includes(order.financial_status);
      if (!paid) return;
      (order.line_items || []).forEach(item => {
        const sku = item.sku || String(item.variant_id);
        if (!sales[sku]) sales[sku] = { qty: 0, title: item.title, variant_title: item.variant_title };
        sales[sku].qty += item.quantity;
      });
    });

    const velocity = {};
    Object.entries(sales).forEach(([sku, d]) => {
      velocity[sku] = { qty_sold: d.qty, units_per_day: parseFloat((d.qty/days).toFixed(3)), title: d.title, variant_title: d.variant_title };
    });

    res.json({ velocity, order_count: orders.length, days_analyzed: days, fetched_at: new Date().toISOString() });
  } catch (err) {
    console.error('[/api/orders]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Sync (products + velocity in one call) ───────────────────────────────────
app.get('/api/sync', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;

    // Products — mandatory
    const rawProducts = await shopifyAll('products', 'status=active');
    const products = rawProducts.map(p => ({
      shopify_id: p.id,
      title: p.title,
      handle: p.handle,
      image: p.images?.[0]?.src || null,
      product_type: p.product_type || '',
      variants: p.variants.map(v => ({
        shopify_variant_id: v.id,
        shopify_inventory_item_id: v.inventory_item_id,
        sku: v.sku || `${p.handle}-${v.title.toLowerCase().replace(/\s/g,'-')}`,
        title: v.title,
        price: parseFloat(v.price),
        stock: v.inventory_quantity ?? 0
      }))
    }));

    // Orders — optional (velocity & market data)
    // If this fails we still return products so the sync is never fully blocked
    let velocity = {};
    let market_breakdown = {};
    let order_count = 0;
    let orders_error = null;

    try {
      const since = new Date();
      since.setDate(since.getDate() - days);
      // Fetch 3 months of orders (covers velocity window + recent monthly breakdown)
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      const fetchSince = since < threeMonthsAgo ? since : threeMonthsAgo;
      const allOrders = await shopifyAll('orders', `status=any&created_at_min=${fetchSince.toISOString()}`);

      const monthly_sales = {};
      allOrders.forEach(order => {
        const paid = ['paid','partially_paid'].includes(order.financial_status);
        if (!paid) return;
        const orderDate = new Date(order.created_at);
        const month = order.created_at.slice(0, 7);
        if (!monthly_sales[month]) monthly_sales[month] = {};

        (order.line_items || []).forEach(item => {
          const sku = item.sku || String(item.variant_id);
          // Monthly breakdown
          if (!monthly_sales[month][sku]) monthly_sales[month][sku] = { qty: 0, title: item.title, variant_title: item.variant_title };
          monthly_sales[month][sku].qty += item.quantity;
          // Velocity (only within the days window)
          if (orderDate >= since) {
            if (!velocity[sku]) velocity[sku] = 0;
            velocity[sku] += item.quantity;
          }
        });
        // Market breakdown (only within the days window)
        if (orderDate >= since) {
          const country = order.billing_address?.country_code || order.shipping_address?.country_code || 'XX';
          if (!market_breakdown[country]) market_breakdown[country] = { qty: 0, revenue: 0 };
          market_breakdown[country].qty += 1;
          market_breakdown[country].revenue += parseFloat(order.total_price || 0);
        }
      });
      order_count = allOrders.filter(o => new Date(o.created_at) >= since).length;

      // Convert to per-day velocity
      Object.keys(velocity).forEach(sku => {
        velocity[sku] = parseFloat((velocity[sku] / days).toFixed(3));
      });

      res.json({
        products, velocity, market_breakdown, monthly_sales,
        order_count, orders_error: null, days_analyzed: days,
        synced_at: new Date().toISOString()
      });
      return;
    } catch(ordErr) {
      console.error('[/api/sync] orders fetch failed (non-fatal):', ordErr.message);
      orders_error = ordErr.message;
    }

    res.json({
      products,
      velocity,
      market_breakdown,
      order_count,
      orders_error,  // null if ok, error string if orders failed
      days_analyzed: days,
      synced_at: new Date().toISOString()
    });

  } catch (err) {
    console.error('[/api/sync]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Drafts ───────────────────────────────────────────────────────────────────
app.get('/api/drafts', async (req, res) => {
  try {
    const products = await shopifyAll('products', 'status=draft');
    const result = products.map(p => ({
      shopify_id: p.id,
      title: p.title,
      handle: p.handle,
      image: p.images?.[0]?.src || null,
      product_type: p.product_type || '',
      status: 'draft',
      variants: p.variants.map(v => ({
        shopify_variant_id: v.id,
        sku: v.sku || `${p.handle}-${v.title.toLowerCase().replace(/\s/g,'-')}`,
        title: v.title,
        price: parseFloat(v.price),
        stock: v.inventory_quantity ?? 0
      }))
    }));
    res.json({ products: result, count: result.length });
  } catch (err) {
    console.error('[/api/drafts]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✓ Listening on port ${PORT}`);
});
