export interface BlogPost {
  id: string;
  slug: string;
  title: string;
  date: string;
  author: string;
  excerpt: string;
  category: string;
}

export const blogPosts: BlogPost[] = [
  {
    id: '1',
    slug: 'what-is-pop-art-wall-art',
    title: 'What Is Pop Art Wall Art and Why Is It Perfect for Your Home?',
    date: '2026-03-15',
    author: 'Comic Strip Canvas Team',
    excerpt: 'From Andy Warhol to your living room — we explore the history of pop art and why comic-style wall art is having a massive moment in UK interior design.',
    category: 'Inspiration',
  },
  {
    id: '2',
    slug: 'choosing-the-right-size-canvas',
    title: 'How to Choose the Right Size Canvas for Your Wall',
    date: '2026-03-08',
    author: 'Comic Strip Canvas Team',
    excerpt: "Don't get caught out by the wrong dimensions. Our complete guide to sizing your wall art correctly, from small gallery pieces to large statement canvases.",
    category: 'Guide',
  },
  {
    id: '3',
    slug: 'personalised-gifts-uk',
    title: 'The Ultimate Personalised Gift: Why Comic Book Art is the One',
    date: '2026-02-28',
    author: 'Comic Strip Canvas Team',
    excerpt: "Looking for a gift that genuinely surprises someone? A personalised comic book canvas might just be the most memorable present you'll ever give.",
    category: 'Gift Ideas',
  },
  {
    id: '4',
    slug: 'canvas-vs-poster-prints',
    title: 'Canvas vs Poster Prints: Which Is Right for You?',
    date: '2026-02-15',
    author: 'Comic Strip Canvas Team',
    excerpt: 'We break down the differences between our canvas prints and poster prints — quality, price, durability, and which works best in different rooms.',
    category: 'Guide',
  },
];
