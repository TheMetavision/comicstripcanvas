import { atom, computed } from 'nanostores';
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
}

export const cartItems = atom<CartItem[]>([]);
export const cartOpen = atom<boolean>(false);

export const cartCount = computed(cartItems, (items) =>
  items.reduce((sum, item) => sum + item.quantity, 0)
);

export const cartTotal = computed(cartItems, (items) =>
  items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
);

export function addToCart(item: Omit<CartItem, 'id'>) {
  const current = cartItems.get();
  const existing = current.find(
    (i) => i.productId === item.productId && i.format === item.format && i.size === item.size
  );
  if (existing) {
    cartItems.set(
      current.map((i) =>
        i.id === existing.id ? { ...i, quantity: i.quantity + item.quantity } : i
      )
    );
  } else {
    cartItems.set([...current, { ...item, id: `${item.productId}-${item.format}-${item.size}-${Date.now()}` }]);
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
