/**
 * "Smart" inbox content: Gmail order/parcel cards and inbox buttons (schema.org JSON-LD),
 * Gmail Promotions annotations, AMP for Email and Outlook Actionable Messages.
 *
 * Clients that do not understand a feature ignore it and show the normal html, so it is
 * always safe to add. Showing it is up to each provider:
 *   - Gmail renders most schema.org types and AMP only for registered senders whose mail
 *     passes SPF + DKIM (sending to your own Gmail address works for testing).
 *     Test markup with Google's Email Markup Tester before registering.
 *   - Outlook renders Adaptive Cards only with an `originator` id from Microsoft's
 *     Actionable Email Developer Dashboard.
 *
 * Run:  SMTP_USER=you@gmail.com SMTP_PASS=<app password> npx tsx examples/rich-inbox-email.ts
 */
import { MailTs, schemaOrg } from '@mailts/core';

const me = process.env['SMTP_USER']!;
const mail = new MailTs({
  smtp: { host: 'smtp.gmail.com', port: 587, auth: { type: 'plain', user: me, pass: process.env['SMTP_PASS']! } },
});

// ── 1. Order confirmation: purchase card + "View order" button in the inbox list ──
const order = await mail.send({
  from: me,
  to: me,
  subject: 'Your Acme order #1234',
  html: '<p>Thanks for your order! <a href="https://shop.example/orders/1234">View order</a></p>',
  structuredData: [
    schemaOrg.order({
      merchant: 'Acme',
      orderNumber: '1234',
      price: 39.9,
      priceCurrency: 'EUR',
      status: 'processing',
      url: 'https://shop.example/orders/1234',
      items: [{ name: 'Coffee mug', sku: 'MUG-01', price: 19.95, quantity: 2 }],
    }),
    schemaOrg.viewAction({ url: 'https://shop.example/orders/1234', name: 'View order' }),
  ],
});
console.log('order:', order.ok ? order.messageId : order.error.message);

// ── 2. Shipping notification: package tracking card ──────────────────────────
await mail.send({
  from: me,
  to: me,
  subject: 'Your order #1234 has shipped',
  html: '<p>On its way with DHL — tracking JD0001.</p>',
  structuredData: schemaOrg.parcelDelivery({
    carrier: 'DHL',
    trackingNumber: 'JD0001',
    trackingUrl: 'https://dhl.example/track/JD0001',
    expectedArrivalUntil: new Date(Date.now() + 3 * 86_400_000),
    order: { orderNumber: '1234', merchant: 'Acme', status: 'in-transit' },
  }),
});

// ── 3. Promotions tab: deal badge with code + image card ─────────────────────
await mail.send({
  from: me,
  to: me,
  subject: 'Autumn sale — 20% off',
  html: '<p>Use code <b>FALL20</b> until Oct 31.</p>',
  structuredData: [
    schemaOrg.discountOffer({ description: '20% off everything', code: 'FALL20', endsAt: '2026-10-31T23:59:59Z' }),
    schemaOrg.promotionCard({ image: 'https://shop.example/img/sale.png', url: 'https://shop.example/sale', headline: 'Autumn sale' }),
  ],
});

// ── 4. AMP for Email: live content where supported, html everywhere else ─────
await mail.send({
  from: me,
  to: me,
  subject: 'Order status (AMP)',
  html: '<p>Status: processing. <a href="https://shop.example/orders/1234">Refresh</a></p>',
  amp: `<!doctype html>
<html ⚡4email data-css-strict>
<head>
  <meta charset="utf-8">
  <script async src="https://cdn.ampproject.org/v0.js"></script>
  <style amp4email-boilerplate>body{visibility:hidden}</style>
</head>
<body><p>Status: processing</p></body>
</html>`,
});

// ── 5. Outlook Actionable Message: approve/reject card ───────────────────────
await mail.send({
  from: me,
  to: me,
  subject: 'Expense report needs approval',
  html: '<p>Open <a href="https://expenses.example/42">the report</a> to approve.</p>',
  adaptiveCard: {
    type: 'AdaptiveCard',
    version: '1.0',
    originator: process.env['OUTLOOK_ORIGINATOR'] ?? '00000000-0000-0000-0000-000000000000',
    body: [{ type: 'TextBlock', text: 'Expense report #42 — €120', weight: 'bolder' }],
    actions: [{ type: 'Action.Http', title: 'Approve', method: 'POST', url: 'https://expenses.example/api/42/approve' }],
  },
});

await mail.shutdown();
