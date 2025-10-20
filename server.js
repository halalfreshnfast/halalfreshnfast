// server.js — Express + Square (Orders + Payments → POS)
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');

const app = express();
const PORT = process.env.PORT || 4000;

// ---------- Square config ----------
const ENV = (process.env.SQUARE_ENV || 'sandbox').toLowerCase();
const BASE = ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

const ACCESS_TOKEN   = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID    = process.env.SQUARE_LOCATION_ID;
const APPLICATION_ID = process.env.SQUARE_APPLICATION_ID;

function sqHeaders() {
  return {
    'Authorization': `Bearer ${ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
    'Square-Version': '2024-06-20',
  };
}

// ---------- Price Book (trusted server prices) ----------
// Edit the inline defaults OR place a JSON file at data/prices.json (auto-loaded & hot-reloaded).
const defaultPriceBook = {
  // ===== EXISTING ITEMS =====
  'Chicken Over Rice': 999,
  'Fish Over Rice': 999,
  'Lamb And Chicken Over Rice': 1099,
  'Lamb Over Rice': 1099,
  'Chicken and Lamb Shawarma': 799,
  'Chicken Shawarma': 799,
  'Chicken Tikka Roll': 799,
  'Kabab Roll': 799,
  'Beef Burger': 699,
  'Beef Burger Combo': 999,
  'Chicken Burger': 599,
  'Chicken Burger Combo': 899,
  'Fish Burger': 599,
  'Fish Burger Combo': 899,
  'Zinger Burger': 599,
  'Zinger Burger Combo': 899,
  'Small Fries': 299,
  'Medium Fries': 399,
  'Large Fries': 499,
  'Chicken with Bone (10 pc)': 1899,
  'Chicken with Bone (3 pc combo)': 999,
  'Chicken with Bone (3 pc)': 599,
  'Chicken with Bone (5 pc)': 999,
  'Chicken Nuggets (5 pc)': 599,
  'Chicken Nuggets Combo': 999,
  'Chicken Tender (3 pc)': 599,
  'Chicken Tender Combo': 999,
  '16 OZ Mango Lassi': 399,
  '16 OZ Salt Lassi': 399,
  '16 OZ Strawberry Lassi': 399,
  '16 OZ Sweet Lassi': 399,
  'Soda Can': 150,
  'Water Bottle': 100,
  'BBQ Wings (5 pc)': 899,
  'Buffalo Wings (5 pc)': 899,
  'Garlic Parmesan Wings (5 pc)': 899,
  'Honey Wings (5 pc)': 899,
  'Chicken Kabab': 250,
  'Chicken Tikka Boti (5 pc)': 699,
  'Tandoor Chicken leg (1 pc)': 499,
  'Tandoor Chicken leg (2 pc)': 899,
  'Rice Pudding': 499,

  // ===== PIZZA (Size variants) =====
  'Cheese Pizza (Small)': 999,
  'Cheese Pizza (Medium)': 1299,
  'Cheese Pizza (Large)': 1499,
  'Cheese Pizza (Extra Large)': 1799,

  'Veggie Pizza (Small)': 1199,
  'Veggie Pizza (Medium)': 1499,
  'Veggie Pizza (Large)': 1799,
  'Veggie Pizza (Extra Large)': 2099,

  'Buffalo Chicken Pizza (Small)': 1199,
  'Buffalo Chicken Pizza (Medium)': 1499,
  'Buffalo Chicken Pizza (Large)': 1799,
  'Buffalo Chicken Pizza (Extra Large)': 2099,

  // ===== Topping surcharge =====
  'Pizza Topping (Small)': 100,        // $1.00
  'Pizza Topping (Medium)': 150,       // $1.50
  'Pizza Topping (Large)': 150,        // $1.50
  'Pizza Topping (Extra Large)': 200,  // $2.00
};

// Live price book (starts with default)
let PRICE_BOOK = { ...defaultPriceBook };

// Optional external prices file for easy updates (hot-reloaded)
const pricesPath = path.join(__dirname, 'data', 'prices.json');

function loadPriceBookFromFile() {
  try {
    const raw = fs.readFileSync(pricesPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      PRICE_BOOK = parsed;
      console.log('🟢 Loaded prices from data/prices.json');
    }
  } catch (_) {/* ignore missing/invalid */}
}

if (fs.existsSync(pricesPath)) {
  loadPriceBookFromFile();
  try {
    fs.watch(pricesPath, { persistent: false }, () => {
      setTimeout(() => {
        try { loadPriceBookFromFile(); console.log('🔁 Reloaded data/prices.json'); }
        catch (e) { console.warn('⚠️ Failed to reload prices.json:', e.message); }
      }, 200);
    });
  } catch (_) {}
}

app.use(express.json());
app.use(express.static(__dirname)); // serve index.html, menu.html, order.html, assets

// ---------- API ROUTES (before wildcard) ----------

// Public config for the frontend
app.get('/api/config', (_req, res) => {
  res.json({ applicationId: APPLICATION_ID, locationId: LOCATION_ID, env: ENV });
});

// Quick self-test
app.get('/api/selftest', (_req, res) => {
  const problems = [];
  if (!APPLICATION_ID) problems.push('Missing SQUARE_APPLICATION_ID');
  if (!LOCATION_ID) problems.push('Missing SQUARE_LOCATION_ID');
  if (!ACCESS_TOKEN) problems.push('Missing SQUARE_ACCESS_TOKEN');
  const mustHave = ['Cheese Pizza (Small)', 'Pizza Topping (Small)'];
  const missing = mustHave.filter(k => !(k in PRICE_BOOK));
  res.json({ ok: problems.length === 0 && missing.length === 0, problems, missingPriceKeys: missing, env: ENV });
});

// ---------- Validation ----------
// Accepts: pickup (default) OR delivery. Address can be free-text or an Address object.
const AddressTextOrObject = z.union([
  z.string().min(1),
  z.object({
    address_line_1: z.string().min(1),
    locality: z.string().optional(),
    administrative_district_level_1: z.string().optional(),
    postal_code: z.string().optional(),
    country: z.string().optional(),
  })
]).optional();

const CheckoutBody = z.object({
  cart: z.array(z.object({ name: z.string(), qty: z.number().int().positive() })),
  contact: z.object({
    name: z.string().min(1),
    phone: z.string().min(7),
    email: z.string().email().optional(),
  }),
  pickupTime: z.string().optional(), // ISO datetime for pickup (optional)
  fulfillment: z.enum(['pickup','delivery']).optional().default('pickup'),
  address: AddressTextOrObject,       // required only if fulfillment=delivery (front-end enforces)
  paymentToken: z.string(),           // Square Web Payments SDK token
});

// ---------- Helpers ----------
const sanitizeCart = (cart) =>
  cart.map(({ name, qty }) => {
    const price = PRICE_BOOK[name];
    if (price == null) throw new Error(`Unknown item: ${name}`);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error(`Bad qty for ${name}`);
    return { name, qty, priceCents: price };
  });

const sumCents = (items) => items.reduce((s, i) => s + i.priceCents * i.qty, 0);

// ---------- Checkout: Create Order → Capture Payment ----------
app.post('/api/checkout', async (req, res) => {
  try {
    const body = CheckoutBody.parse(req.body);
    const items = sanitizeCart(body.cart);

    const TAX_RATE_PERCENT = Number(process.env.TAX_RATE_PERCENT ?? 8.0);
    const DELIVERY_FEE_CENTS = Number(process.env.DELIVERY_FEE_CENTS ?? 0);

    // Build base line items
    const line_items = items.map(i => ({
      name: i.name,
      quantity: String(i.qty),
      base_price_money: { amount: i.priceCents, currency: 'USD' },
    }));

    // Optional delivery fee as a separate line item
    const isDelivery = (body.fulfillment || 'pickup') === 'delivery';
    if (isDelivery && DELIVERY_FEE_CENTS > 0) {
      line_items.push({
        name: 'Delivery Fee',
        quantity: '1',
        base_price_money: { amount: DELIVERY_FEE_CENTS, currency: 'USD' },
      });
    }

    // Build order object
    const orderObj = {
      location_id: LOCATION_ID,
      line_items,
    };

    if (TAX_RATE_PERCENT > 0) {
      orderObj.taxes = [{
        name: 'Sales Tax',
        type: 'ADDITIVE',
        scope: 'ORDER',
        percentage: String(TAX_RATE_PERCENT),
      }];
    }

    // ----- Fulfillment: PICKUP or DELIVERY -----
    let pickup_details, delivery_details;

    if (isDelivery) {
      // Normalize address: accept free text or Square Address object
      let delivery_address;
      if (typeof body.address === 'string') {
        delivery_address = { address_line_1: body.address, country: 'US' };
      } else if (body.address) {
        delivery_address = {
          address_line_1: body.address.address_line_1,
          locality: body.address.locality,
          administrative_district_level_1: body.address.administrative_district_level_1,
          postal_code: body.address.postal_code,
          country: body.address.country || 'US',
        };
      }

      delivery_details = {
        recipient: {
          display_name: body.contact.name,
          phone_number: body.contact.phone,
          email_address: body.contact.email,
        },
        schedule_type: 'ASAP',
        delivery_address, // may be undefined if not provided; front-end should require this
      };
    } else {
      pickup_details = {
        recipient: {
          display_name: body.contact.name,
          phone_number: body.contact.phone,
          email_address: body.contact.email,
        },
        schedule_type: body.pickupTime ? 'SCHEDULED' : 'ASAP',
        pickup_at: body.pickupTime,
      };
    }

    orderObj.fulfillments = [{
      type: isDelivery ? 'DELIVERY' : 'PICKUP',
      state: 'PROPOSED',
      pickup_details,
      delivery_details,
    }];

    // Create Order
    const orderPayload = { idempotency_key: crypto.randomUUID(), order: orderObj };
    const orderResp = await fetch(`${BASE}/v2/orders`, {
      method: 'POST',
      headers: sqHeaders(),
      body: JSON.stringify(orderPayload),
    });
    const orderJson = await orderResp.json();
    if (!orderResp.ok) {
      throw new Error(orderJson.errors?.[0]?.detail || 'Square createOrder failed');
    }
    const orderId = orderJson.order.id;

    // Totals (server-authoritative)
    const subtotalCents = sumCents(items) + (isDelivery ? DELIVERY_FEE_CENTS : 0);
    const taxCents = TAX_RATE_PERCENT > 0 ? Math.round(subtotalCents * (TAX_RATE_PERCENT / 100)) : 0;
    const totalCents = subtotalCents + taxCents;

    // Charge Payment
    const payPayload = {
      idempotency_key: crypto.randomUUID(),
      source_id: body.paymentToken,
      location_id: LOCATION_ID,
      amount_money: { amount: totalCents, currency: 'USD' },
      order_id: orderId,
    };

    const payResp = await fetch(`${BASE}/v2/payments`, {
      method: 'POST',
      headers: sqHeaders(),
      body: JSON.stringify(payPayload),
    });
    const payJson = await payResp.json();
    if (!payResp.ok) {
      throw new Error(payJson.errors?.[0]?.detail || 'Square createPayment failed');
    }

    res.json({ success: true, orderId, paymentId: payJson.payment?.id });
  } catch (e) {
    console.error(e);
    res.status(400).json({ success: false, error: e.message || 'Checkout failed' });
  }
});

// ---------- Wildcard LAST (fallback to home) ----------
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Server running → http://localhost:${PORT} (${ENV})`);
});