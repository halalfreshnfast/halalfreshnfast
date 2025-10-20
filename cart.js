// cart.js — shared cart across pages (Menu + Checkout)
// Stores in localStorage so it persists across navigation.

const LS_KEY = "hfnf_cart_v1";

function read() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { return []; }
}
function write(cart) {
  localStorage.setItem(LS_KEY, JSON.stringify(cart));
  window.dispatchEvent(new CustomEvent("cart:update", { detail: { cart } }));
}
export function getCart() { return read(); }
export function clearCart() { write([]); }

export function addItem(name, priceCents, qty = 1) {
  qty = Math.max(1, parseInt(qty || "1", 10));
  const cart = read();
  const existing = cart.find(i => i.name === name);
  if (existing) existing.qty += qty;
  else cart.push({ name, priceCents, qty });
  write(cart);
}

export function removeItem(index) {
  const cart = read();
  cart.splice(index, 1);
  write(cart);
}

export function setQty(index, qty) {
  qty = Math.max(1, parseInt(qty || "1", 10));
  const cart = read();
  if (!cart[index]) return;
  cart[index].qty = qty;
  write(cart);
}

export function subtotalCents() {
  return read().reduce((s, i) => s + i.priceCents * i.qty, 0);
}

// Utility for money formatting
export function money(cents) { return "$" + (cents / 100).toFixed(2); }