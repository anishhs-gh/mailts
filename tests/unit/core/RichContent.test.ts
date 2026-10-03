import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { applyRichContent, schemaOrg } from '../../../src/core/RichContent.js';
import { buildMessage } from '../../../src/core/Message.js';
import { parseMessage } from '../../../src/core/MimeParser.js';
import { MailTs } from '../../../src/core/MailTs.js';
import { SendGridTransport, ResendTransport, PostmarkTransport } from '../../../src/transports/index.js';
import type { Transport } from '../../../src/transports/Transport.js';
import type { EmailOptions } from '../../../src/types/core.js';

const base = { from: 'shop@x.com', to: 'buyer@x.com', subject: 'Order 1234' };
const AMP = '<!doctype html><html ⚡4email data-css-strict><head><meta charset="utf-8"><script async src="https://cdn.ampproject.org/v0.js"></script></head><body>Hi</body></html>';

/** JSON-LD nodes inside the html, parsed back. */
function ldNodes(html: string, type = 'application/ld+json'): unknown[] {
  const re = new RegExp(`<script type="${type.replace(/[+]/g, '\\+')}">([\\s\\S]*?)</script>`, 'g');
  return [...html.matchAll(re)].map(m => JSON.parse(m[1]!));
}

describe('schemaOrg builders', () => {
  it('order: merchant, status URL, offers with quantity and inherited currency', () => {
    const o = schemaOrg.order({
      merchant: 'Acme', orderNumber: '1234', price: 59.9, priceCurrency: 'EUR', status: 'processing',
      orderDate: new Date('2026-10-01T10:00:00Z'), items: [{ name: 'Mug', sku: 'M-1', price: 19.95, quantity: 2 }],
    });
    expect(o).toEqual({
      '@context': 'https://schema.org', '@type': 'Order',
      merchant: { '@type': 'Organization', name: 'Acme' },
      orderNumber: '1234', price: 59.9, priceCurrency: 'EUR', orderDate: '2026-10-01T10:00:00.000Z',
      orderStatus: 'https://schema.org/OrderProcessing',
      acceptedOffer: [{
        '@type': 'Offer', itemOffered: { '@type': 'Product', name: 'Mug', sku: 'M-1' },
        price: 19.95, priceCurrency: 'EUR', eligibleQuantity: { '@type': 'QuantitativeValue', value: 2 },
      }],
    });
  });

  it('parcelDelivery: carrier, tracking, address and parent order', () => {
    const p = schemaOrg.parcelDelivery({
      carrier: 'DHL', trackingNumber: 'JD0001', trackingUrl: 'https://dhl.example/JD0001',
      expectedArrivalUntil: '2026-10-05', deliveryAddress: { street: '1 Main St', locality: 'Berlin', country: 'DE' },
      order: { orderNumber: '1234', merchant: 'Acme', status: 'in-transit' },
    });
    expect(p).toMatchObject({
      '@type': 'ParcelDelivery', carrier: { name: 'DHL' }, trackingNumber: 'JD0001', expectedArrivalUntil: '2026-10-05',
      deliveryAddress: { '@type': 'PostalAddress', streetAddress: '1 Main St', addressLocality: 'Berlin', addressCountry: 'DE' },
      partOfOrder: { '@type': 'Order', orderNumber: '1234', orderStatus: 'https://schema.org/OrderInTransit' },
    });
  });

  it('reservations share status, underName and extra', () => {
    const f = schemaOrg.flightReservation({
      reservationNumber: 'RXJ34P', name: 'Ada Lovelace', extra: { airplaneSeat: '9A' },
      flight: {
        airline: { name: 'Lufthansa', iataCode: 'LH' }, flightNumber: '454',
        departureAirport: { iataCode: 'FRA' }, departureTime: '2026-11-01T10:00:00+01:00', arrivalAirport: { iataCode: 'SFO' },
      },
    });
    expect(f).toMatchObject({
      '@type': 'FlightReservation', reservationStatus: 'https://schema.org/ReservationConfirmed',
      underName: { '@type': 'Person', name: 'Ada Lovelace' }, airplaneSeat: '9A',
      reservationFor: { '@type': 'Flight', airline: { '@type': 'Airline', iataCode: 'LH' }, departureAirport: { '@type': 'Airport', iataCode: 'FRA' } },
    });

    const l = schemaOrg.lodgingReservation({
      reservationNumber: 'H1', name: 'Ada', status: 'cancelled', hotel: { name: 'Hotel X', address: 'Somewhere 1' },
      checkin: '2026-11-01', checkout: '2026-11-03',
    });
    expect(l).toMatchObject({
      reservationStatus: 'https://schema.org/ReservationCancelled',
      checkinTime: '2026-11-01', checkinDate: '2026-11-01', checkoutTime: '2026-11-03', checkoutDate: '2026-11-03',
      reservationFor: { '@type': 'LodgingBusiness', address: 'Somewhere 1' },
    });

    expect(schemaOrg.eventReservation({
      reservationNumber: 'E1', name: 'Ada', ticketNumber: 'T-9',
      event: { name: 'Concert', startDate: '2026-12-01T20:00:00Z', location: { name: 'Hall' } },
    })).toMatchObject({ reservationFor: { '@type': 'Event', location: { '@type': 'Place', name: 'Hall' } }, reservedTicket: { ticketNumber: 'T-9' } });

    expect(schemaOrg.foodReservation({
      reservationNumber: 'F1', name: 'Ada', restaurant: { name: 'Bistro' }, startTime: '2026-12-01T19:00:00Z', partySize: 4,
    })).toMatchObject({ '@type': 'FoodEstablishmentReservation', partySize: 4, reservationFor: { '@type': 'FoodEstablishment' } });
  });

  it('actions and Promotions annotations', () => {
    expect(schemaOrg.viewAction({ url: 'https://x.com/o/1', name: 'Track order' })).toEqual({
      '@context': 'https://schema.org', '@type': 'EmailMessage',
      potentialAction: { '@type': 'ViewAction', url: 'https://x.com/o/1', name: 'Track order' },
    });
    expect(schemaOrg.discountOffer({ description: '20% off', code: 'FALL20', endsAt: new Date('2026-10-31T23:59:59Z') }))
      .toMatchObject({ '@type': 'DiscountOffer', discountCode: 'FALL20', availabilityEnds: '2026-10-31T23:59:59.000Z' });
    expect(schemaOrg.promotionCard({ image: 'https://x.com/i.png', headline: 'New in' })).toMatchObject({ '@type': 'PromotionCard', image: 'https://x.com/i.png' });
  });

  it('rejects missing required fields', () => {
    expect(() => schemaOrg.order({ merchant: 'Acme', orderNumber: '' })).toThrow(/orderNumber/);
    expect(() => schemaOrg.parcelDelivery({ carrier: 'DHL', order: { orderNumber: '1', merchant: '' } })).toThrow(/order.merchant/);
    expect(() => schemaOrg.viewAction({ url: '', name: 'x' })).toThrow(/url/);
  });
});

describe('applyRichContent', () => {
  it('injects JSON-LD before </head>, adds @context, and is idempotent', () => {
    const once = applyRichContent({ ...base, html: '<html><head><title>t</title></head><body>Hi</body></html>', structuredData: { '@type': 'Order', orderNumber: '1' } });
    expect(once.structuredData).toBeUndefined();
    expect(once.html).toMatch(/<title>t<\/title><script type="application\/ld\+json">.*<\/script><\/head>/);
    expect(ldNodes(once.html!)).toEqual([{ '@context': 'https://schema.org', '@type': 'Order', orderNumber: '1' }]);
    expect(applyRichContent(once)).toBe(once);
  });

  it('creates a <head> for documents and fragments without one; several nodes become an array', () => {
    const doc = applyRichContent({ ...base, html: '<html lang="en"><body>x</body></html>', structuredData: [schemaOrg.viewAction({ url: 'https://x', name: 'Go' }), { '@type': 'Order', orderNumber: '2' }] });
    expect(doc.html).toMatch(/^<html lang="en"><head><script type="application\/ld\+json">/);
    expect((ldNodes(doc.html!)[0] as unknown[]).length).toBe(2);
    const frag = applyRichContent({ ...base, html: '<p>x</p>', structuredData: { '@type': 'Order', orderNumber: '3' } });
    expect(frag.html).toMatch(/^<head><script[^>]*>.*<\/script><\/head><p>x<\/p>$/);
  });

  it('escapes values so they cannot close the script tag', () => {
    const out = applyRichContent({ ...base, html: '<p>x</p>', structuredData: { '@type': 'Order', orderNumber: '</script><img src=x onerror=alert(1)>& ' } });
    expect(out.html).not.toContain('</script><img');
    expect(out.html!.match(/<\/script/gi)).toHaveLength(1); // only the real closing tag
    expect(out.html).not.toMatch(/<img/);
    expect((ldNodes(out.html!)[0] as { orderNumber: string }).orderNumber).toBe('</script><img src=x onerror=alert(1)>& ');
  });

  it('renders an Adaptive Card and validates it', () => {
    const card = { type: 'AdaptiveCard', version: '1.0', originator: 'abc-123', body: [{ type: 'TextBlock', text: 'Approve?' }] };
    const out = applyRichContent({ ...base, html: '<p>x</p>', adaptiveCard: card });
    expect(ldNodes(out.html!, 'application/adaptivecard+json')).toEqual([card]);
    expect(() => applyRichContent({ ...base, html: '<p>x</p>', adaptiveCard: { type: 'AdaptiveCard' } })).toThrow(/originator/);
    expect(() => applyRichContent({ ...base, html: '<p>x</p>', adaptiveCard: { type: 'Other', originator: 'a' } })).toThrow(/AdaptiveCard/);
  });

  it('rejects invalid input', () => {
    expect(() => applyRichContent({ ...base, text: 'x', structuredData: { '@type': 'Order' } })).toThrow(/html body/);
    expect(() => applyRichContent({ ...base, html: '<p>x</p>', structuredData: [] })).toThrow(/empty/);
    expect(() => applyRichContent({ ...base, html: '<p>x</p>', structuredData: { name: 'no type' } as never })).toThrow(/@type/);
    expect(() => applyRichContent({ ...base, html: '<p>x</p>', amp: '<html><body>not amp</body></html>' })).toThrow(/AMP for Email/);
    expect(() => applyRichContent({ ...base, text: 'x', amp: AMP })).toThrow(/html fallback/);
    expect(() => applyRichContent({ ...base, html: '<p>x</p>', amp: AMP.replace('⚡4email', 'amp4email') })).not.toThrow();
  });
});

describe('MIME output', () => {
  it('multipart/alternative is text → AMP → html, JSON-LD stays out of the generated text', async () => {
    const built = await buildMessage({
      ...base, html: '<p>Thanks for your order</p>', amp: AMP,
      structuredData: schemaOrg.order({ merchant: 'Acme', orderNumber: '1234' }),
    });
    const raw = built.raw.toString();
    const types = [...raw.matchAll(/Content-Type: (text\/[a-z-]+)/g)].map(m => m[1]);
    expect(types).toEqual(['text/plain', 'text/x-amp-html', 'text/html']);
    const parsed = parseMessage(built.raw);
    expect(parsed.text).toContain('Thanks for your order');
    expect(parsed.text).not.toContain('schema.org');
    expect(ldNodes(parsed.html!)[0]).toMatchObject({ '@type': 'Order', orderNumber: '1234' });
  });

  it('MailTs hands JSON transports the rendered html', async () => {
    const seen: EmailOptions[] = [];
    const transport: Transport = { name: 'cap', async send(m, o) { seen.push(o); return { messageId: m.messageId, accepted: m.to, rejected: [] }; } };
    const r = await new MailTs({ transport }).send({ ...base, html: '<p>x</p>', structuredData: { '@type': 'Order', orderNumber: '9' } });
    expect(r.ok).toBe(true);
    expect(seen[0]!.structuredData).toBeUndefined();
    expect(ldNodes(seen[0]!.html!)[0]).toMatchObject({ orderNumber: '9' });
    const bad = await new MailTs({ transport }).send({ ...base, text: 'x', structuredData: { '@type': 'Order' } });
    expect(bad.ok).toBe(false);
  });
});

describe('JSON API transports', () => {
  const servers: http.Server[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise(r => { s.closeAllConnections(); s.close(r); }))); });
  async function api(status = 200, headers: Record<string, string> = {}) {
    const bodies: unknown[] = [];
    const server = http.createServer((req, res) => {
      let b = '';
      req.on('data', c => { b += c; });
      req.on('end', () => { bodies.push(b ? JSON.parse(b) : null); res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end('{"id":"1","MessageID":"1"}'); });
    });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
  }

  it('SendGrid sends AMP between text and html, and renders structured data when used directly', async () => {
    const s = await api(202, { 'x-message-id': 'sg' });
    const opts: EmailOptions = { ...base, text: 'plain', html: '<p>x</p>', amp: AMP, structuredData: { '@type': 'Order', orderNumber: '5' } };
    await new SendGridTransport({ apiKey: 'k', baseUrl: s.base }).send(await buildMessage(opts), opts);
    const content = (s.bodies[0] as { content: Array<{ type: string; value: string }> }).content;
    expect(content.map(c => c.type)).toEqual(['text/plain', 'text/x-amp-html', 'text/html']);
    expect(content[2]!.value).toContain('application/ld+json');
  });

  it('Resend and Postmark refuse AMP instead of silently dropping it', async () => {
    const s = await api();
    const opts: EmailOptions = { ...base, html: '<p>x</p>', amp: AMP };
    const built = await buildMessage(opts);
    await expect(new ResendTransport({ apiKey: 'k', baseUrl: s.base }).send(built, opts)).rejects.toThrow(/not supported by the Resend/);
    await expect(new PostmarkTransport({ serverToken: 't', baseUrl: s.base }).send(built, opts)).rejects.toThrow(/not supported by the Postmark/);
    expect(s.bodies).toHaveLength(0);
  });
});
