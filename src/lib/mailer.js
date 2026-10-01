// src/lib/mailer.js
import nodemailer from 'nodemailer';

let transporterPromise = null;
let usingEthereal = false;

async function getTransporter() {
  if (transporterPromise) return transporterPromise;

  transporterPromise = (async () => {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

    if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
      return nodemailer.createTransport({
        host: SMTP_HOST,
        port: Number(SMTP_PORT) || 587,
        secure: Number(SMTP_PORT) === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      });
    }

    // No real SMTP configured — fall back to a throwaway Ethereal test
    // inbox so emails still send end-to-end during development instead of
    // silently no-op'ing. Every send logs a preview link to the console;
    // nothing goes to a real mailbox.
    usingEthereal = true;
    const testAccount = await nodemailer.createTestAccount();
    console.log('\n[mailer] No SMTP_* env vars set - using a temporary Ethereal test inbox.');
    console.log('[mailer] Set SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM to send real email.\n');

    return nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
  })();

  return transporterPromise;
}

const FROM = process.env.MAIL_FROM || '"GamingCorner" <no-reply@gamingcorner.local>';
const STORE_NOTIFICATION_EMAIL = process.env.STORE_NOTIFICATION_EMAIL || null;

async function send({ to, subject, html }) {
  if (!to) return null;

  const transporter = await getTransporter();
  const info = await transporter.sendMail({ from: FROM, to, subject, html });

  if (usingEthereal) {
    console.log(`[mailer] Preview "${subject}" -> ${to}: ${nodemailer.getTestMessageUrl(info)}`);
  }

  return info;
}

const STATUS_LABELS = {
  pending: 'Pending',
  in_preparation: 'In Preparation',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

function itemsToHtml(items) {
  return items
    .map((i) => `<li>${i.product_name} x ${i.quantity} - $${Number(i.line_total).toFixed(2)}</li>`)
    .join('');
}

// Sent once, right after a successful checkout: a confirmation to the
// customer (only if they gave an email - it's optional at checkout) and a
// new-order notification to the store, if STORE_NOTIFICATION_EMAIL is set.
// Either, both, or neither may fire depending on what's configured/given -
// this never throws, so a missing address just means that half is skipped.
export async function sendOrderConfirmationEmail(order, items = []) {
  const subtotal = Number(order.subtotal).toFixed(2);
  const itemsHtml = itemsToHtml(items);

  const tasks = [];

  if (order.email) {
    tasks.push(
      send({
        to: order.email,
        subject: `Order #${order.id} confirmed`,
        html: `
          <h2>Thanks for your order, ${order.first_name}!</h2>
          <p>Order #${order.id} has been placed and is now <strong>Pending</strong>.</p>
          <ul>${itemsHtml}</ul>
          <p><strong>Subtotal: $${subtotal}</strong></p>
          <p>Delivery cost will be confirmed by the store shortly.</p>
          <p>Address: ${order.address_line}, ${order.area}, ${order.city}, ${order.governorate}</p>
        `,
      })
    );
  }

  if (STORE_NOTIFICATION_EMAIL) {
    tasks.push(
      send({
        to: STORE_NOTIFICATION_EMAIL,
        subject: `New order #${order.id}`,
        html: `
          <h2>New order #${order.id}</h2>
          <p>${order.first_name} ${order.last_name} - ${order.phone_country_code}${order.phone_number}</p>
          <p>${order.address_line}, ${order.area}, ${order.city}, ${order.governorate}</p>
          <ul>${itemsHtml}</ul>
          <p><strong>Subtotal: $${subtotal}</strong></p>
        `,
      })
    );
  }

  return Promise.allSettled(tasks);
}

// Sent whenever an admin moves an order to a new status. Silently does
// nothing if the order has no email on file.
export async function sendOrderStatusEmail(order) {
  if (!order.email) return null;

  const label = STATUS_LABELS[order.status] || order.status;

  return send({
    to: order.email,
    subject: `Order #${order.id} is now ${label}`,
    html: `
      <h2>Order #${order.id} update</h2>
      <p>Your order status is now: <strong>${label}</strong>.</p>
      ${order.status === 'cancelled' ? '<p>If you believe this is a mistake, please contact the store.</p>' : ''}
    `,
  });
}
