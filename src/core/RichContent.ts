/**
 * Mail-client "smart" content: schema.org JSON-LD (Gmail highlights, actions and
 * Promotions annotations), Outlook Actionable Messages (Adaptive Cards) and
 * AMP for Email validation. All of it is opt-in and travels inside the HTML or
 * as its own MIME part — clients that do not understand it ignore it.
 */
import { MimeError } from '../errors.js';
import type { EmailOptions } from '../types/core.js';

/** A JSON-LD node. `@context` defaults to `https://schema.org`. */
export interface JsonLd {
  '@context'?: string;
  '@type': string;
  [key: string]: unknown;
}

const CONTEXT = 'https://schema.org';

/**
 * Returns options with `structuredData` / `adaptiveCard` rendered into `html`
 * (and those fields removed, so applying twice is a no-op), after validating
 * them and `amp`. Called by `buildMessage()` and before JSON transports.
 */
export function applyRichContent(options: EmailOptions): EmailOptions {
  const { structuredData, adaptiveCard, ...rest } = options;
  if (rest.amp !== undefined) checkAmp(rest.amp, rest.html);
  if (structuredData === undefined && adaptiveCard === undefined) return options;
  if (!rest.html) throw new MimeError('structuredData and adaptiveCard need an html body');

  const scripts: string[] = [];
  if (structuredData !== undefined) {
    const nodes = Array.isArray(structuredData) ? structuredData : [structuredData];
    if (nodes.length === 0) throw new MimeError('structuredData is empty');
    const withContext = nodes.map((n) => {
      checkNode(n, 'structuredData');
      return n['@context'] ? n : { '@context': CONTEXT, ...n };
    });
    scripts.push(scriptTag('application/ld+json', withContext.length === 1 ? withContext[0] : withContext));
  }
  if (adaptiveCard !== undefined) {
    checkNode(adaptiveCard, 'adaptiveCard');
    if (adaptiveCard['@type'] !== 'AdaptiveCard' && adaptiveCard['type'] !== 'AdaptiveCard') {
      throw new MimeError('adaptiveCard must be an Adaptive Card ("type": "AdaptiveCard")');
    }
    if (typeof adaptiveCard['originator'] !== 'string' || !adaptiveCard['originator']) {
      throw new MimeError('adaptiveCard needs "originator" — the provider id registered with Microsoft');
    }
    scripts.push(scriptTag('application/adaptivecard+json', adaptiveCard));
  }
  return { ...rest, html: injectIntoHead(rest.html, scripts.join('')) };
}

function checkNode(n: unknown, field: string): asserts n is Record<string, unknown> {
  if (typeof n !== 'object' || n === null || Array.isArray(n)) throw new MimeError(`${field} entries must be objects`);
  const type = (n as Record<string, unknown>)['@type'] ?? (n as Record<string, unknown>)['type'];
  if (typeof type !== 'string' || !type) throw new MimeError(`${field} entries need a "@type"`);
}

/** JSON inside <script>: escape everything that could close the tag or break parsing. */
function scriptTag(type: string, value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new MimeError('structured content must be JSON-serialisable');
  }
  json = json
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<script type="${type}">${json}</script>`;
}

function injectIntoHead(html: string, markup: string): string {
  const headClose = /<\/head\s*>/i.exec(html);
  if (headClose) return html.slice(0, headClose.index) + markup + html.slice(headClose.index);
  const htmlOpen = /<html\b[^>]*>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<head>${markup}</head>${html}`;
}

function checkAmp(amp: string, html: string | undefined): void {
  if (typeof amp !== 'string' || !amp.trim()) throw new MimeError('amp must be a non-empty string');
  if (!/<html\b[^>]*(\u26A14email|\bamp4email\b)/i.test(amp)) {
    throw new MimeError('amp must be an AMP for Email document (<html ⚡4email> or <html amp4email>)');
  }
  if (!html) throw new MimeError('amp needs an html fallback — clients without AMP show the html part');
}

// ── schema.org builders ──────────────────────────────────────────────────────

type DateLike = Date | string;
const iso = (d: DateLike | undefined): string | undefined => (d instanceof Date ? d.toISOString() : d);

/** Drop undefined values so the JSON stays minimal. */
function clean<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function need(value: unknown, name: string): void {
  if (value === undefined || value === null || value === '') throw new MimeError(`schemaOrg: "${name}" is required`);
}

export interface PostalAddressInput {
  street?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

function postalAddress(a: PostalAddressInput | string | undefined): unknown {
  if (a === undefined || typeof a === 'string') return a;
  return clean({
    '@type': 'PostalAddress',
    streetAddress: a.street,
    addressLocality: a.locality,
    addressRegion: a.region,
    postalCode: a.postalCode,
    addressCountry: a.country,
  });
}

const org = (name: string, extra: Record<string, unknown> = {}) => clean({ '@type': 'Organization', name, ...extra });

export type OrderStatus =
  | 'processing' | 'in-transit' | 'delivered' | 'pickup-available' | 'payment-due' | 'problem' | 'returned' | 'cancelled';

const ORDER_STATUS: Record<OrderStatus, string> = {
  'processing': 'OrderProcessing',
  'in-transit': 'OrderInTransit',
  'delivered': 'OrderDelivered',
  'pickup-available': 'OrderPickupAvailable',
  'payment-due': 'OrderPaymentDue',
  'problem': 'OrderProblem',
  'returned': 'OrderReturned',
  'cancelled': 'OrderCancelled',
};

export interface ProductInput {
  name: string;
  sku?: string;
  url?: string;
  image?: string;
  price?: number | string;
  priceCurrency?: string;
  quantity?: number;
}

export type ReservationStatus = 'confirmed' | 'cancelled' | 'pending' | 'hold';

const RESERVATION_STATUS: Record<ReservationStatus, string> = {
  confirmed: 'ReservationConfirmed',
  cancelled: 'ReservationCancelled',
  pending: 'ReservationPending',
  hold: 'ReservationHold',
};

interface ReservationBase {
  reservationNumber: string;
  /** Default `'confirmed'`. */
  status?: ReservationStatus;
  /** Name of the person the reservation is for. */
  name: string;
  email?: string;
  /** Page where the user can view or manage the reservation. */
  url?: string;
  /** Extra properties merged into the top-level node (e.g. Google-specific fields). */
  extra?: Record<string, unknown>;
}

function reservation(type: string, r: ReservationBase, body: Record<string, unknown>): JsonLd {
  need(r.reservationNumber, 'reservationNumber');
  need(r.name, 'name');
  return clean({
    '@context': CONTEXT,
    '@type': type,
    reservationNumber: r.reservationNumber,
    reservationStatus: `${CONTEXT}/${RESERVATION_STATUS[r.status ?? 'confirmed']}`,
    underName: clean({ '@type': 'Person', name: r.name, email: r.email }),
    url: r.url,
    ...body,
    ...r.extra,
  });
}

interface AirportInput { iataCode: string; name?: string }

/**
 * Typed builders for the schema.org types mail clients use. The output is plain
 * JSON-LD for `EmailOptions.structuredData`; anything not covered can be passed
 * as a raw `JsonLd` object. Gmail shows most of these only for registered
 * senders whose mail passes SPF/DKIM — check with Google's Email Markup Tester.
 *
 * @example
 * ```ts
 * await mail.send({ to, subject: 'Your order #1234', html,
 *   structuredData: schemaOrg.order({ merchant: 'Acme', orderNumber: '1234', price: 59.9, priceCurrency: 'EUR' }) });
 * ```
 */
export const schemaOrg = {
  /** Purchase confirmation / order update (Gmail purchase summaries). */
  order(o: {
    merchant: string;
    orderNumber: string;
    price?: number | string;
    priceCurrency?: string;
    orderDate?: DateLike;
    status?: OrderStatus;
    url?: string;
    items?: ProductInput[];
    extra?: Record<string, unknown>;
  }): JsonLd {
    need(o.merchant, 'merchant');
    need(o.orderNumber, 'orderNumber');
    return clean({
      '@context': CONTEXT,
      '@type': 'Order',
      merchant: org(o.merchant),
      orderNumber: o.orderNumber,
      price: o.price,
      priceCurrency: o.priceCurrency,
      orderDate: iso(o.orderDate),
      orderStatus: o.status ? `${CONTEXT}/${ORDER_STATUS[o.status]}` : undefined,
      url: o.url,
      acceptedOffer: o.items?.map(i => clean({
        '@type': 'Offer',
        itemOffered: clean({ '@type': 'Product', name: i.name, sku: i.sku, url: i.url, image: i.image }),
        price: i.price,
        priceCurrency: i.priceCurrency ?? o.priceCurrency,
        eligibleQuantity: i.quantity !== undefined ? { '@type': 'QuantitativeValue', value: i.quantity } : undefined,
      })),
      ...o.extra,
    });
  },

  /** Shipping notification with tracking (Gmail package tracking). */
  parcelDelivery(p: {
    carrier: string;
    trackingNumber?: string;
    trackingUrl?: string;
    expectedArrivalFrom?: DateLike;
    expectedArrivalUntil?: DateLike;
    deliveryAddress?: PostalAddressInput | string;
    items?: ProductInput[];
    order: { orderNumber: string; merchant: string; status?: OrderStatus };
    extra?: Record<string, unknown>;
  }): JsonLd {
    need(p.carrier, 'carrier');
    need(p.order?.orderNumber, 'order.orderNumber');
    need(p.order?.merchant, 'order.merchant');
    return clean({
      '@context': CONTEXT,
      '@type': 'ParcelDelivery',
      carrier: org(p.carrier),
      trackingNumber: p.trackingNumber,
      trackingUrl: p.trackingUrl,
      expectedArrivalFrom: iso(p.expectedArrivalFrom),
      expectedArrivalUntil: iso(p.expectedArrivalUntil),
      deliveryAddress: postalAddress(p.deliveryAddress),
      itemShipped: p.items?.map(i => clean({ '@type': 'Product', name: i.name, sku: i.sku, url: i.url, image: i.image })),
      partOfOrder: clean({
        '@type': 'Order',
        orderNumber: p.order.orderNumber,
        merchant: org(p.order.merchant),
        orderStatus: p.order.status ? `${CONTEXT}/${ORDER_STATUS[p.order.status]}` : undefined,
      }),
      ...p.extra,
    });
  },

  flightReservation(r: ReservationBase & {
    flight: {
      airline: { name: string; iataCode: string };
      flightNumber: string;
      departureAirport: AirportInput;
      departureTime: DateLike;
      arrivalAirport: AirportInput;
      arrivalTime?: DateLike;
    };
  }): JsonLd {
    const f = r.flight;
    need(f?.flightNumber, 'flight.flightNumber');
    need(f?.departureTime, 'flight.departureTime');
    need(f?.departureAirport?.iataCode, 'flight.departureAirport.iataCode');
    need(f?.arrivalAirport?.iataCode, 'flight.arrivalAirport.iataCode');
    return reservation('FlightReservation', r, {
      reservationFor: clean({
        '@type': 'Flight',
        flightNumber: f.flightNumber,
        airline: clean({ '@type': 'Airline', name: f.airline.name, iataCode: f.airline.iataCode }),
        departureAirport: clean({ '@type': 'Airport', name: f.departureAirport.name, iataCode: f.departureAirport.iataCode }),
        departureTime: iso(f.departureTime),
        arrivalAirport: clean({ '@type': 'Airport', name: f.arrivalAirport.name, iataCode: f.arrivalAirport.iataCode }),
        arrivalTime: iso(f.arrivalTime),
      }),
    });
  },

  lodgingReservation(r: ReservationBase & {
    hotel: { name: string; address: PostalAddressInput | string; telephone?: string };
    checkin: DateLike;
    checkout: DateLike;
  }): JsonLd {
    need(r.hotel?.name, 'hotel.name');
    need(r.checkin, 'checkin');
    need(r.checkout, 'checkout');
    return reservation('LodgingReservation', r, {
      reservationFor: clean({
        '@type': 'LodgingBusiness',
        name: r.hotel.name,
        address: postalAddress(r.hotel.address),
        telephone: r.hotel.telephone,
      }),
      // schema.org names these checkinTime/checkoutTime; Gmail's reference uses checkinDate/checkoutDate.
      checkinTime: iso(r.checkin),
      checkoutTime: iso(r.checkout),
      checkinDate: iso(r.checkin),
      checkoutDate: iso(r.checkout),
    });
  },

  eventReservation(r: ReservationBase & {
    event: { name: string; startDate: DateLike; endDate?: DateLike; location: { name: string; address?: PostalAddressInput | string } };
    ticketNumber?: string;
  }): JsonLd {
    need(r.event?.name, 'event.name');
    need(r.event?.startDate, 'event.startDate');
    need(r.event?.location?.name, 'event.location.name');
    return reservation('EventReservation', r, {
      reservationFor: clean({
        '@type': 'Event',
        name: r.event.name,
        startDate: iso(r.event.startDate),
        endDate: iso(r.event.endDate),
        location: clean({ '@type': 'Place', name: r.event.location.name, address: postalAddress(r.event.location.address) }),
      }),
      reservedTicket: r.ticketNumber ? { '@type': 'Ticket', ticketNumber: r.ticketNumber } : undefined,
    });
  },

  foodReservation(r: ReservationBase & {
    restaurant: { name: string; address?: PostalAddressInput | string; telephone?: string };
    startTime: DateLike;
    partySize: number;
  }): JsonLd {
    need(r.restaurant?.name, 'restaurant.name');
    need(r.startTime, 'startTime');
    need(r.partySize, 'partySize');
    return reservation('FoodEstablishmentReservation', r, {
      reservationFor: clean({
        '@type': 'FoodEstablishment',
        name: r.restaurant.name,
        address: postalAddress(r.restaurant.address),
        telephone: r.restaurant.telephone,
      }),
      startTime: iso(r.startTime),
      partySize: r.partySize,
    });
  },

  /** A button in the Gmail inbox list that opens `url` ("Go-To action"). */
  viewAction(a: { url: string; name: string; description?: string }): JsonLd {
    need(a.url, 'url');
    need(a.name, 'name');
    return clean({
      '@context': CONTEXT,
      '@type': 'EmailMessage',
      description: a.description,
      potentialAction: { '@type': 'ViewAction', url: a.url, name: a.name },
    });
  },

  /** Gmail Promotions tab: deal badge with code and validity. */
  discountOffer(d: { description: string; code?: string; startsAt?: DateLike; endsAt?: DateLike }): JsonLd {
    need(d.description, 'description');
    return clean({
      '@context': CONTEXT,
      '@type': 'DiscountOffer',
      description: d.description,
      discountCode: d.code,
      availabilityStarts: iso(d.startsAt),
      availabilityEnds: iso(d.endsAt),
    });
  },

  /** Gmail Promotions tab: product/offer image card. */
  promotionCard(c: {
    image: string;
    url?: string;
    headline?: string;
    price?: number | string;
    priceCurrency?: string;
    discountValue?: number | string;
    position?: number;
  }): JsonLd {
    need(c.image, 'image');
    return clean({
      '@context': CONTEXT,
      '@type': 'PromotionCard',
      image: c.image,
      url: c.url,
      headline: c.headline,
      price: c.price,
      priceCurrency: c.priceCurrency,
      discountValue: c.discountValue,
      position: c.position,
    });
  },
};
