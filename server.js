// server.js — Express + Square (Orders + Payments → POS)
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');           // ✅ only once
const crypto = require('crypto');
const { z } = require('zod');

const app = express();
const PORT = process.env.PORT || 4000;

/* -------------------------------------------------------
   CORS
   During testing we allow all. When ready, lock to Netlify.
-------------------------------------------------------- */
app.use(cors()); // allow all while you finish setup
// To lock down later, replace the line above with:
//
// const ALLOWED_ORIGINS = [
//   'https://halalfreshnfast.netlify.app', // your Netlify URL
//   'http://localhost:8888',               // Netlify dev
//   'http://localhost:3000',
// ];
// app.use(
//   cors({
//     origin: (origin, cb) => {
//       if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
//       cb(new Error('Not allowed by CORS'));
//     },
//     methods: ['GET', 'POST'],
//     allowedHeaders: ['Content-Type']
//   })
// );

/* -------------------------------------------------------
   Middleware & static files
-------------------------------------------------------- */
app.use(express.json());
app.use(express.static(__dirname)); // serve index.html, menu.html, order.html, images, css, etc.

/* -------------------------------------------------------
   Square config
-------------------------------------------------------- */
const ENV = (process.env.SQUARE_ENV || 'sandbox').toLowerCase();
const BASE =
  ENV === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

const ACCESS_TOKEN   = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID    = process.env.SQUARE_LOCATION_ID;
const APPLICATION_ID = process.env.SQUARE_APPLICATION_ID;

function sqHeaders() {
  return {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
    'Square-Version': '2024-06-20',
  };
}

/* -------------------------------------------------------
   Price Book (authoritative server prices)
-------------------------------------------------------- */
const defaultPriceBook = {
  // ===== RICE PLATTERS =====
  'Chicken Over Rice': 999,
  'Fish Over Rice': 999,
  'Lamb And Chicken Over Rice': 1099,
  'Lamb Over Rice': 1099,

  // ===== WRAPS =====
  'Chicken and Lamb Shawarma': 799,
  'Chicken Shawarma': 799,
  'Chicken Tikka Roll': 799,
  'Kabab Roll': 799,

  // ===== BURGERS =====
  'Beef Burger': 699,
  'Beef Burger Combo': 999,
  'Chicken Burger': 599,
  'Chicken Burger Combo': 899,
  'Fish Burger': 599,
  'Fish Burger Combo': 899,
  'Zinger Burger': 599,
  'Zinger Burger Combo': 899,

  // ===== SIDES =====
  'Small Fries': 299,
  'Medium Fries': 399,
  'Large Fries': 499,
  'Chicken Nuggets (5 pc)': 599,
  'Chicken Nuggets Combo': 999,
  'Chicken Tender (3 pc)': 599,
  'Chicken Tender Combo': 999,

  // ===== DRINKS =====
  '16 OZ Mango Lassi': 399,
  '16 OZ Sweet Lassi': 399,
  '16 OZ Salt Lassi': 399,
  'Soda Can': 150,
  'Water Bottle': 100,

  // ===== WINGS =====
  'BBQ Wings (5 pc)': 899,
  'Buffalo Wings (5 pc)': 899,
  'Garlic Parmesan Wings (5 pc)': 899,

  // ===== BBQ =====
  'Chicken Kabab': 250,
  'Chicken Tikka Boti (5 pc)': 699,
  'Tandoor Chicken leg (1 pc)': 499,
  'Tandoor Chicken leg (2 pc)': 899,

  // ===== DESSERT =====
  'Rice Pudding': 499,
  "Perry's Ice Cream (8 oz cup)": 499,
  "Perry's Cone": 200,
  'Gulab Jamun (3 pc)': 399,

  // ===== PIZZA (new pricing) =====
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

  // ===== TOPPINGS =====
  'Pizza Topping (Small)': 100,
  'Pizza Topping (Medium)': 150,
  'Pizza Topping (Large)': 150,
  'Pizza Topping (Extra Large)': 200,
};

// live price book (can be replaced by data/prices.json)
let PRICE_BOOK = { ...defaultPriceBook };

// Optional: load external prices with hot reload
const pricesPath = path.join(__dirname, 'data', 'prices.json');
function loadPriceBookFromFile() {
  try {
    const raw = fs.readFileSync(pricesPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      PRICE_BOOK = parsed;
      console.log('🟢 Loaded prices from data/prices.json');
    }
  } catch (_) {}
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

/* -------------------------------------------------------
   API
-------------------------------------------------------- */

// Public config for frontend
app.get('/api/config', (_req, res) => {
  res.json({ applicationId: APPLICATION_ID, locationId: LOCATION_ID, env: ENV });
});

// Health/self-test
app.get('/api/selftest', (_req, res) => {
  const problems = [];
  if (!APPLICATION_ID) problems.push('Missing SQUARE_APPLICATION_ID');
  if (!LOCATION_ID) problems.push('Missing SQUARE_LOCATION_ID');
  if (!ACCESS_TOKEN) problems.push('Missing SQUARE_ACCESS_TOKEN');
  const mustHave = ['Cheese Pizza (Small)', 'Pizza Topping (Small)'];
  const missing = mustHave.filter(k => !(k in PRICE_BOOK));
  res.json({ ok: problems.length === 0 && missing.length === 0, problems, missingPriceKeys: missing, env: ENV });
});

/* -------------------------------------------------------
   Validation
-------------------------------------------------------- */
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
  pickupTime: z.string().optional(),
  fulfillment: z.enum(['pickup','delivery']).optional().default('pickup'),
  address: AddressTextOrObject,
  paymentToken: z.string(),
});

/* -------------------------------------------------------
   Helpers
-------------------------------------------------------- */
const sanitizeCart = (cart) =>
  cart.map(({ name, qty }) => {
    const price = PRICE_BOOK[name];
    if (price == null) throw new Error(`Unknown item: ${name}`);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error(`Bad qty for ${name}`);
    return { name, qty, priceCents: price };
  });

const sumCents = (items) => items.reduce((s, i) => s + i.priceCents * i.qty, 0);

/* -------------------------------------------------------
   Checkout → Create Order → Capture Payment
-------------------------------------------------------- */
app.post('/api/checkout', async (req, res) => {
  try {
    const body  = CheckoutBody.parse(req.body);
    const items = sanitizeCart(body.cart);

    const TAX_RATE_PERCENT   = Number(process.env.TAX_RATE_PERCENT ?? 8.0);
    const DELIVERY_FEE_CENTS = Number(process.env.DELIVERY_FEE_CENTS ?? 0);

    const line_items = items.map(i => ({
      name: i.name,
      quantity: String(i.qty),
      base_price_money: { amount: i.priceCents, currency: 'USD' },
    }));

    const isDelivery = (body.fulfillment || 'pickup') === 'delivery';
    if (isDelivery && DELIVERY_FEE_CENTS > 0) {
      line_items.push({
        name: 'Delivery Fee',
        quantity: '1',
        base_price_money: { amount: DELIVERY_FEE_CENTS, currency: 'USD' },
      });
    }

    const orderObj = { location_id: LOCATION_ID, line_items };

    if (TAX_RATE_PERCENT > 0) {
      orderObj.taxes = [{
        name: 'Sales Tax',
        type: 'ADDITIVE',
        scope: 'ORDER',
        percentage: String(TAX_RATE_PERCENT),
      }];
    }

    let pickup_details, delivery_details;
    if (isDelivery) {
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
        delivery_address,
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

    // Create order
    const orderPayload = { idempotency_key: crypto.randomUUID(), order: orderObj };
    const orderResp = await fetch(`${BASE}/v2/orders`, {
      method: 'POST',
      headers: sqHeaders(),
      body: JSON.stringify(orderPayload),
    });
    const orderJson = await orderResp.json();
    if (!orderResp.ok) throw new Error(orderJson.errors?.[0]?.detail || 'Square createOrder failed');
    const orderId = orderJson.order.id;

    // Totals
    const subtotalCents = sumCents(items) + (isDelivery ? DELIVERY_FEE_CENTS : 0);
    const taxCents      = TAX_RATE_PERCENT > 0 ? Math.round(subtotalCents * (TAX_RATE_PERCENT / 100)) : 0;
    const totalCents    = subtotalCents + taxCents;

    // Take payment
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
    if (!payResp.ok) throw new Error(payJson.errors?.[0]?.detail || 'Square createPayment failed');

    res.json({ success: true, orderId, paymentId: payJson.payment?.id });
  } catch (e) {
    console.error(e);
    res.status(400).json({ success: false, error: e.message || 'Checkout failed' });
  }
});

/* -------------------------------------------------------
   Fallback route
-------------------------------------------------------- */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Server running → http://localhost:${PORT} (${ENV})`);
});