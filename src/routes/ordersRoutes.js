import { Router } from 'express';
import pool from '../../db.js';
import { sendOrderConfirmationEmail } from '../lib/mailer.js';

const router = Router();

const REQUIRED_FIELDS = [
  'first_name',
  'last_name',
  'phone_country_code',
  'phone_number',
  'governorate',
  'city',
  'area',
  'address_line',
];

// POST /api/orders — place an order from the checkout page.
// Body: { first_name, last_name, phone_country_code, phone_number,
//         governorate, city, area, address_line,
//         items: [{ product_id, quantity }, ...] }
//
// Pricing is always looked up server-side from the products table — the
// client only sends product ids + quantities, never prices, so a tampered
// request can't check out at a fake price.
router.post('/', async (req, res) => {
  const body = req.body || {};
  const { items } = body;

  for (const field of REQUIRED_FIELDS) {
    if (!body[field] || String(body[field]).trim() === '') {
      return res.status(400).json({ success: false, message: `${field} is required.` });
    }
  }

  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
    return res.status(400).json({ success: false, message: 'That email address doesn\'t look valid.' });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Your cart is empty.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const productIds = items.map((i) => Number(i.product_id)).filter(Number.isFinite);
    const { rows: productRows } = await client.query(
      `SELECT id, name, sku, price, sale_price FROM products WHERE id = ANY($1::int[])`,
      [productIds]
    );
    const productMap = new Map(productRows.map((p) => [p.id, p]));

    let subtotal = 0;
    const lineItems = [];

    for (const item of items) {
      const product = productMap.get(Number(item.product_id));
      const quantity = Number(item.quantity) || 0;

      if (!product) {
        throw new Error(`Product ${item.product_id} is no longer available.`);
      }
      if (quantity <= 0) {
        throw new Error(`Invalid quantity for ${product.name}.`);
      }

      const unitPrice = Number(product.sale_price ?? product.price ?? 0);
      const lineTotal = Math.round(unitPrice * quantity * 100) / 100;
      subtotal += lineTotal;

      lineItems.push({
        product_id: product.id,
        product_name: product.name,
        product_sku: product.sku,
        unit_price: unitPrice,
        quantity,
        line_total: lineTotal,
      });
    }

    subtotal = Math.round(subtotal * 100) / 100;

    const orderResult = await client.query(
      `INSERT INTO orders
        (first_name, last_name, phone_country_code, phone_number, governorate, city, area, address_line, email, subtotal, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
       RETURNING *`,
      [
        body.first_name,
        body.last_name,
        body.phone_country_code,
        body.phone_number,
        body.governorate,
        body.city,
        body.area,
        body.address_line,
        body.email?.trim() || null,
        subtotal,
      ]
    );
    const order = orderResult.rows[0];

    for (const li of lineItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, product_sku, unit_price, quantity, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, li.product_id, li.product_name, li.product_sku, li.unit_price, li.quantity, li.line_total]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      data: {
        ...order,
        total: Number(order.subtotal), // delivery_price is still null at this point
        items: lineItems,
      },
    });

    // Fire-and-forget: never let email trouble affect the response already
    // sent to the customer's browser.
    sendOrderConfirmationEmail(order, lineItems).catch((err) =>
      console.error('Failed to send order confirmation email:', err.message)
    );
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating order:', err);
    res.status(400).json({ success: false, message: err.message || 'Failed to place order.' });
  } finally {
    client.release();
  }
});

// GET /api/orders/:id — public order lookup, used by the order status /
// confirmation page. Anyone with the order id/link can view it (no login
// system exists in this app), same as most guest-checkout stores.
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await pool.query(
      `SELECT *, subtotal + COALESCE(delivery_price, 0) AS total FROM orders WHERE id = $1`,
      [id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    const itemsResult = await pool.query(
      `SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC`,
      [id]
    );

    res.json({
      success: true,
      data: {
        ...orderResult.rows[0],
        items: itemsResult.rows,
      },
    });
  } catch (err) {
    console.error('Error fetching order:', err);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

// POST /api/orders/lookup — used by the "Track Order" flow. Order ids are
// just sequential integers, so letting anyone view full name/phone/address
// off a bare GET /:id would make it trivial to page through other people's
// orders. This requires the phone number on file to match before revealing
// anything, and returns a generic 404 either way (doesn't say phone/id
// mismatch specifically) so it can't be used to confirm which orders exist.
router.post('/lookup', async (req, res) => {
  try {
    const { id, phone_number } = req.body || {};

    if (!id || !phone_number) {
      return res.status(400).json({ success: false, message: 'Order ID and phone number are required.' });
    }

    const digitsOnly = String(phone_number).replace(/\D/g, '');

    const orderResult = await pool.query(
      `SELECT *, subtotal + COALESCE(delivery_price, 0) AS total
       FROM orders
       WHERE id = $1
         AND regexp_replace(phone_country_code || phone_number, '\\D', '', 'g') = $2`,
      [id, digitsOnly]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "We couldn't find an order matching that ID and phone number.",
      });
    }

    const itemsResult = await pool.query(
      `SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC`,
      [orderResult.rows[0].id]
    );

    res.json({
      success: true,
      data: { ...orderResult.rows[0], items: itemsResult.rows },
    });
  } catch (err) {
    console.error('Error looking up order:', err);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

export default router;
