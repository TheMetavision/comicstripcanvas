/**
 * What a forwarded Sendcloud status means for us.
 *
 * The service forwards Sendcloud's own status id and message (statusCode,
 * status). Ids first, because messages are carrier-flavoured free text; the
 * message is the fallback for an id this table does not know. The ids the
 * service's tools/simulate-event.mjs sends are all here, so the test plan
 * exercises the same mapping production uses.
 *
 *   pre_transit       the label exists but no carrier has scanned it
 *   in_transit        a carrier has it
 *   ready_to_collect  waiting at a locker / shop for someone to collect
 *   delivered         delivered (or collected by the addressee)
 *   exception         a problem a human must look at
 *   returned_to_sender
 */

const BY_CODE = new Map([
  // pre-transit: label made, nothing scanned yet; cancellations too
  [1, 'pre_transit'],       // Announced
  [13, 'pre_transit'],      // Announced: not collected
  [999, 'pre_transit'],     // No label
  [1000, 'pre_transit'],    // Ready to send
  [1001, 'pre_transit'],    // Being announced
  [1999, 'pre_transit'],    // Cancellation requested
  [2000, 'pre_transit'],    // Cancelled
  [2001, 'pre_transit'],    // Submitting cancellation request
  // delivered
  [11, 'delivered'],        // Delivered
  [93, 'delivered'],        // Shipment collected by customer
  // waiting to be collected
  [12, 'ready_to_collect'], // Awaiting customer pickup
  // problems
  [8, 'exception'],         // Delivery attempt failed
  [15, 'exception'],        // Error collecting
  [80, 'exception'],        // Unable to deliver
  [1002, 'exception'],      // Announcement failed
  [62990, 'exception'],     // Refused by recipient
  [62996, 'exception'],     // Exception
  [62991, 'returned_to_sender'],
  [62992, 'returned_to_sender'],
]);

export function classifyStatus(statusCode, message) {
  const code = Number(statusCode);
  if (BY_CODE.has(code)) return BY_CODE.get(code);
  const m = String(message || '').toLowerCase();
  if (/return(ed)? to sender/.test(m)) return 'returned_to_sender';
  if (/exception|unable|fail|error|refused|invalid|lost|damaged/.test(m)) return 'exception';
  if (/awaiting .*pick ?up|ready (for|to) (collect|pick)/.test(m)) return 'ready_to_collect';
  if (/collected by (customer|recipient)|^delivered/.test(m)) return 'delivered';
  if (/announced|ready to send|no label|cancel/.test(m)) return 'pre_transit';
  // Any other scan -- sorted, en route, out for delivery -- means a carrier has it.
  return 'in_transit';
}

/**
 * True when the event shows a carrier has physically had the parcel. An
 * exception does not count on its own: "announcement failed" is an exception
 * with nothing collected, and must not tell the customer it is on its way.
 */
const SCANNED = new Set(['in_transit', 'ready_to_collect', 'delivered', 'returned_to_sender']);
export const isCarrierScan = (kind) => SCANNED.has(kind);
