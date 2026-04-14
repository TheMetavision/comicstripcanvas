export type ProductFormat = 'poster' | 'canvas-standard' | 'canvas-gallery';
export type ProductSize = 'small' | 'medium' | 'large';
export type ProductCategory = 'comic-book-covers' | 'comic-book-icons' | 'comic-book-strips' | 'personalised';

export interface Product {
  id: string;
  slug: string;
  title: string;
  category: ProductCategory;
  description: string;
  basePrice: number;
  accentColor: string;
  tags: string[];
  isPersonalised?: boolean;
}

export const PRICES: Record<ProductFormat, Record<ProductSize, number>> = {
  poster: { small: 9.99, medium: 12.99, large: 16.99 },
  'canvas-standard': { small: 26.99, medium: 31.99, large: 44.99 },
  'canvas-gallery': { small: 28.99, medium: 33.99, large: 46.99 },
};

export const SIZES: Record<ProductSize, string> = {
  small: 'Small (12x8")',
  medium: 'Medium (16x12")',
  large: 'Large (24x16")',
};

export const FORMAT_LABELS: Record<ProductFormat, string> = {
  poster: 'Poster Print',
  'canvas-standard': 'Canvas (Standard Frame)',
  'canvas-gallery': 'Canvas (Gallery Frame)',
};

export const products: Product[] = [
  {
    id: '1',
    slug: 'retro-hero-cover',
    title: 'Retro Hero Comic Cover',
    category: 'comic-book-covers',
    description: 'A bold, vintage-style comic book cover featuring a classic superhero silhouette with dramatic halftone shading and a retro colour palette.',
    basePrice: 9.99,
    accentColor: '#EC008C',
    tags: ['hero', 'retro', 'cover'],
  },
  {
    id: '2',
    slug: 'golden-age-villain',
    title: 'Golden Age Villain Cover',
    category: 'comic-book-covers',
    description: 'Channel the drama of the golden age of comics with this menacing villain cover design, complete with dramatic speech bubbles.',
    basePrice: 9.99,
    accentColor: '#FFF200',
    tags: ['villain', 'golden age', 'cover'],
  },
  {
    id: '3',
    slug: 'silver-age-team',
    title: 'Silver Age Team Cover',
    category: 'comic-book-covers',
    description: 'A dynamic team composition inspired by the silver age of comics, with vibrant colours and dynamic action poses.',
    basePrice: 9.99,
    accentColor: '#00AEEF',
    tags: ['team', 'silver age', 'cover'],
  },
  {
    id: '4',
    slug: 'pop-art-icon-woman',
    title: 'Pop Art Icon — Power Woman',
    category: 'comic-book-icons',
    description: 'A striking pop-art portrait in vivid primary colours, transforming everyday empowerment into iconic wall art.',
    basePrice: 9.99,
    accentColor: '#EC008C',
    tags: ['pop art', 'icon', 'portrait'],
  },
  {
    id: '5',
    slug: 'street-art-rebel',
    title: 'Street Art Rebel Icon',
    category: 'comic-book-icons',
    description: 'Bold graphic icon design fusing street art aesthetics with comic book styling for maximum visual impact.',
    basePrice: 9.99,
    accentColor: '#FFF200',
    tags: ['street art', 'icon', 'rebel'],
  },
  {
    id: '6',
    slug: 'neon-night-icon',
    title: 'Neon Night Icon',
    category: 'comic-book-icons',
    description: 'A luminous pop-culture icon rendered in electric neon tones against a deep dark background.',
    basePrice: 9.99,
    accentColor: '#00AEEF',
    tags: ['neon', 'icon', 'night'],
  },
  {
    id: '7',
    slug: 'daily-adventure-strip',
    title: 'The Daily Adventure Strip',
    category: 'comic-book-strips',
    description: 'A three-panel horizontal comic strip capturing a humorous everyday scenario reimagined as a comic book adventure.',
    basePrice: 9.99,
    accentColor: '#EC008C',
    tags: ['adventure', 'strip', 'humour'],
  },
  {
    id: '8',
    slug: 'origin-story-strip',
    title: 'Origin Story Strip',
    category: 'comic-book-strips',
    description: 'Everyone has an origin story. This four-panel strip tells the tale of how an ordinary moment became extraordinary.',
    basePrice: 9.99,
    accentColor: '#FFF200',
    tags: ['origin', 'strip', 'story'],
  },
  {
    id: '9',
    slug: 'kitchen-chaos-strip',
    title: 'Kitchen Chaos Comic Strip',
    category: 'comic-book-strips',
    description: 'A witty comic strip depicting the everyday chaos of cooking, reimagined with superhero flair and dramatic action.',
    basePrice: 9.99,
    accentColor: '#00AEEF',
    tags: ['kitchen', 'strip', 'comedy'],
  },
  {
    id: '10',
    slug: 'personalised-cover',
    title: 'Your Photo as a Comic Book Cover',
    category: 'personalised',
    description: 'Transform your favourite photo into a stunning personalised comic book cover. You become the hero of your own story.',
    basePrice: 9.99,
    accentColor: '#EC008C',
    tags: ['personalised', 'cover', 'custom'],
    isPersonalised: true,
  },
  {
    id: '11',
    slug: 'personalised-icon',
    title: 'Your Portrait as a Pop Icon',
    category: 'personalised',
    description: 'We transform your photo into a bold, graphic pop-art icon in the style of the greats. Totally unique, totally you.',
    basePrice: 9.99,
    accentColor: '#FFF200',
    tags: ['personalised', 'icon', 'portrait'],
    isPersonalised: true,
  },
  {
    id: '12',
    slug: 'personalised-strip',
    title: 'Your Life as a Comic Strip',
    category: 'personalised',
    description: 'Tell your story panel by panel. We create a bespoke comic strip from your photos, capturing your moments in comic book glory.',
    basePrice: 9.99,
    accentColor: '#00AEEF',
    tags: ['personalised', 'strip', 'story'],
    isPersonalised: true,
  },
];

export function getProductsByCategory(category: ProductCategory): Product[] {
  return products.filter(p => p.category === category);
}

export function getProductBySlug(slug: string): Product | undefined {
  return products.find(p => p.slug === slug);
}
