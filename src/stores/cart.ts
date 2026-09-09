import { atom, computed } from 'nanostores';
import { persistentAtom } from '@nanostores/persistent';
import type { ProductFormat, ProductSize } from '../data/products';
import { PRICES } from '../data/products';

export interface CartItem {
  id: string;
  productId: string;
  slug: string;
  title: string;
  format: ProductFormat;
  size: ProductSize;
  quantity: number;
  unitPrice: number;
  accentColor: string;
  imageUrl?: string;
  /** pendingPersonalisation._id, when this line was built in the product builder. */
  personalisationId?: string;
  /**
   * Snapshot of the customer's own build: /api/personalisation-thumb/<id>.
   * Shown instead of imageUrl so the basket line is their artwork rather than
   * the generic product shot. A URL, never a data: URI -- this atom is
   * persisted to localStorage, which a few hundred KB of base64 per line would
   * fill. Absent when the snapshot failed, and imageUrl carries the line.
   */
  thumbUrl?: string;
  /** e.g. "Comic cover · 16 × 24 in · gallery wrap · 1 photo" */
  description?: string;
}

// Free postage threshold — single source of truth for CSC.
// Used by the cart UI AND the /api/checkout endpoint so they can't drift.
export const FREE_SHIPPING_THRESHOLD = 50;
export const STANDARD_SHIPPING_RATE = 4.95;

// Persisted cart — survives navigation, reload, and tab close.
// "-v1" suffix lets us invalidate stale carts cleanly if CartItem ever changes shape.
export const cartItems = persistentAtom<CartItem[]>('csc-cart-v1', [], {
  encode: JSON.stringify,
  decode: JSON.parse,
});

// Drawer open/close — does NOT persist (always starts closed on a fresh page load)
export const cartOpen = atom<boolean>(false);

export const cartCount = computed(cartItems, (items) =>
  items.reduce((sum, item) => sum + item.quantity, 0)
);

export const cartTotal = computed(cartItems, (items) =>
  items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
);

export const qualifiesForFreeShipping = computed(cartTotal, (total) =>
  total >= FREE_SHIPPING_THRESHOLD
);

export const amountToFreeShipping = computed(cartTotal, (total) =>
  Math.max(0, FREE_SHIPPING_THRESHOLD - total)
);

export function addToCart(item: Omit<CartItem, 'id'>) {
  const current = cartItems.get();
  // Every personalised build is unique -- two covers at the same size and format
  // are different artwork -- so those lines must never merge into one another.
  const existing = item.personalisationId
    ? undefined
    : current.find(
        (i) =>
          !i.personalisationId &&
          i.productId === item.productId &&
          i.format === item.format &&
          i.size === item.size
      );
  if (existing) {
    cartItems.set(
      current.map((i) =>
        i.id === existing.id ? { ...i, quantity: i.quantity + item.quantity } : i
      )
    );
  } else {
    const id = item.personalisationId
      ? `${item.personalisationId}`
      : `${item.productId}-${item.format}-${item.size}-${Date.now()}`;
    cartItems.set([...current, { ...item, id }]);
  }
  cartOpen.set(true);
}

export function removeFromCart(id: string) {
  cartItems.set(cartItems.get().filter((i) => i.id !== id));
}

export function updateQuantity(id: string, quantity: number) {
  if (quantity < 1) {
    removeFromCart(id);
    return;
  }
  cartItems.set(cartItems.get().map((i) => (i.id === id ? { ...i, quantity } : i)));
}

export function clearCart() {
  cartItems.set([]);
}

export function getPriceForFormatSize(format: ProductFormat, size: ProductSize): number {
  return PRICES[format][size];
}
