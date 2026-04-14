/**
 * Comic Strip Canvas — Sanity Seed Data
 *
 * Run this to populate your Sanity project with initial content.
 *
 * Usage:
 *   cd studio
 *   npx sanity dataset import ../sanity-seed.ndjson production
 *
 * Or use the Sanity CLI mutations API:
 *   npx sanity exec ../seed-sanity.ts --with-user-token
 */

import { createClient } from '@sanity/client';

const client = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN, // Set this env var before running
  useCdn: false,
});

async function seed() {
  console.log('Seeding Comic Strip Canvas...');

  // ─── Site Settings ────────────────────────────────────────
  await client.createOrReplace({
    _id: 'siteSettings',
    _type: 'siteSettings',
    siteName: 'Comic Strip Canvas',
    tagline: 'Bold Pop Culture Wall Art UK',
    contactEmail: '', // TODO: Add your contact email
    socialLinks: {
      instagram: '',
      facebook: '',
      tiktok: '',
      twitter: '',
    },
    announcementBar: {
      enabled: false,
      text: '',
      linkUrl: '',
    },
    newsletterHeading: 'For all the latest news, deals and more...',
  });
  console.log('✓ Site Settings');

  // ─── Testimonials ─────────────────────────────────────────
  const testimonials = [
    {
      _type: 'testimonial',
      customerName: 'Emma R.',
      location: 'Manchester',
      rating: 5,
      quote: "I ordered a Comic Icons canvas of The Godfather for my husband's birthday. The quality is incredible and the bold style makes such a statement on our wall. He can't stop showing it off.",
      product: 'Comic Icons Canvas',
      featured: true,
    },
    {
      _type: 'testimonial',
      customerName: 'James & Sophie L.',
      location: 'London',
      rating: 5,
      quote: 'I had our wedding photo turned into a Comic Book Cover. The proof came back in less than 48 hours, and the team worked with me on tiny tweaks until it was perfect. Our friends were blown away.',
      product: 'Personalised Comic Book Cover',
      featured: true,
    },
    {
      _type: 'testimonial',
      customerName: 'Tom S.',
      location: 'Bristol',
      rating: 5,
      quote: 'The Jimi Hendrix Comic Strip canvas is pure art! Bright, punchy colours and a brilliant layout that feels straight out of a vintage comic book. Delivery was super quick too.',
      product: 'Comic Strip Canvas',
      featured: true,
    },
    {
      _type: 'testimonial',
      customerName: 'Hannah G.',
      location: 'Glasgow',
      rating: 5,
      quote: "I uploaded a picture of our French Bulldog, and the team turned it into a hilarious Comic Icon print complete with a speech bubble. It's become a talking point for every visitor.",
      product: 'Personalised Comic Icon',
      featured: true,
    },
    {
      _type: 'testimonial',
      customerName: 'Khalid A.',
      location: 'Birmingham',
      rating: 5,
      quote: 'I bought the Arsenal Invincibles cover and the detail is spot on. It captures the era perfectly, and the frame finish is high quality. Will definitely be ordering more.',
      product: 'Comic Book Cover Canvas',
      featured: true,
    },
  ];

  for (const t of testimonials) {
    await client.create(t);
  }
  console.log(`✓ ${testimonials.length} Testimonials`);

  // ─── FAQs ─────────────────────────────────────────────────
  const faqs = [
    {
      _type: 'faq',
      question: 'How does the personalised service work?',
      answer: "Simply choose your style (Comic Book Cover, Pop Art Icon, or Comic Strip), upload your photo(s), provide any customisation details, and place your order. Our artists will create a digital proof within 24-48 hours. Once you approve the proof, we print and dispatch your artwork.",
      sortOrder: 1,
      page: 'services',
    },
    {
      _type: 'faq',
      question: 'What sizes are available?',
      answer: 'We offer three sizes: Small (12x8"), Medium (16x12"), and Large (24x16"). All sizes are available as Poster Prints, Canvas Standard Frame, and Canvas Gallery Frame.',
      sortOrder: 2,
      page: 'services',
    },
    {
      _type: 'faq',
      question: 'What styles can I choose from?',
      answer: "We offer three distinct styles: Comic Book Covers (bold, dramatic panel-style covers), Comic Book Icons (pop-art inspired graphic portraits), and Comic Book Strips (multi-panel sequential storytelling). Each style is also available as a ready-made design or fully personalised with your own photos.",
      sortOrder: 3,
      page: 'services',
    },
    {
      _type: 'faq',
      question: 'Will I get to see a proof before you print?',
      answer: "Yes! For all personalised orders, we send a digital proof via email within 24-48 hours of receiving your order. You can request up to two rounds of revisions before we go to print. We don't start printing until you've given your approval.",
      sortOrder: 4,
      page: 'services',
    },
    {
      _type: 'faq',
      question: 'How long does delivery take?',
      answer: "For personalised items, please allow 3-6 working days from proof approval. For standard (non-personalised) prints, allow 3-5 working days. All orders are sent via tracked delivery. You'll receive a tracking number when your order ships.",
      sortOrder: 5,
      page: 'services',
    },
    {
      _type: 'faq',
      question: 'Do you ship internationally?',
      answer: "Currently we ship to mainland UK only, with free P&P included on all orders. We're working on expanding to Europe and further afield — sign up to our newsletter to be notified when international shipping launches.",
      sortOrder: 6,
      page: 'services',
    },
    {
      _type: 'faq',
      question: 'What is your returns policy?',
      answer: "Because our products are made to order, we cannot accept returns unless the item is faulty or damaged. If your order arrives damaged, please contact us within 48 hours with photos and we'll arrange a replacement. Personalised items cannot be returned unless they arrive with a printing defect.",
      sortOrder: 7,
      page: 'services',
    },
  ];

  for (const f of faqs) {
    await client.create(f);
  }
  console.log(`✓ ${faqs.length} FAQs`);

  // ─── Placeholder Products ─────────────────────────────────
  const products = [
    { title: 'Retro Hero Comic Cover', slug: 'retro-hero-cover', category: 'comic-book-covers', description: 'A bold, vintage-style comic book cover featuring a classic superhero silhouette with dramatic halftone shading and a retro colour palette.', accentColor: '#EC008C', tags: ['hero', 'retro'], sortOrder: 1 },
    { title: 'Golden Age Villain Cover', slug: 'golden-age-villain', category: 'comic-book-covers', description: 'Channel the drama of the golden age of comics with this menacing villain cover design, complete with dramatic speech bubbles.', accentColor: '#FFF200', tags: ['villain', 'golden age'], sortOrder: 2 },
    { title: 'Silver Age Team Cover', slug: 'silver-age-team', category: 'comic-book-covers', description: 'A dynamic team composition inspired by the silver age of comics, with vibrant colours and dynamic action poses.', accentColor: '#00AEEF', tags: ['team', 'silver age'], sortOrder: 3 },
    { title: 'Pop Art Icon — Power Woman', slug: 'pop-art-icon-woman', category: 'comic-book-icons', description: 'A striking pop-art portrait in vivid primary colours, transforming everyday empowerment into iconic wall art.', accentColor: '#EC008C', tags: ['pop art', 'icon'], sortOrder: 1 },
    { title: 'Street Art Rebel Icon', slug: 'street-art-rebel', category: 'comic-book-icons', description: 'Bold graphic icon design fusing street art aesthetics with comic book styling for maximum visual impact.', accentColor: '#FFF200', tags: ['street art', 'icon'], sortOrder: 2 },
    { title: 'Neon Night Icon', slug: 'neon-night-icon', category: 'comic-book-icons', description: 'A luminous pop-culture icon rendered in electric neon tones against a deep dark background.', accentColor: '#00AEEF', tags: ['neon', 'icon'], sortOrder: 3 },
    { title: 'The Daily Adventure Strip', slug: 'daily-adventure-strip', category: 'comic-book-strips', description: 'A three-panel horizontal comic strip capturing a humorous everyday scenario reimagined as a comic book adventure.', accentColor: '#EC008C', tags: ['adventure', 'humour'], sortOrder: 1 },
    { title: 'Origin Story Strip', slug: 'origin-story-strip', category: 'comic-book-strips', description: 'Everyone has an origin story. This four-panel strip tells the tale of how an ordinary moment became extraordinary.', accentColor: '#FFF200', tags: ['origin', 'story'], sortOrder: 2 },
    { title: 'Kitchen Chaos Comic Strip', slug: 'kitchen-chaos-strip', category: 'comic-book-strips', description: 'A witty comic strip depicting the everyday chaos of cooking, reimagined with superhero flair and dramatic action.', accentColor: '#00AEEF', tags: ['kitchen', 'comedy'], sortOrder: 3 },
    { title: 'Your Photo as a Comic Book Cover', slug: 'personalised-cover', category: 'personalised', description: 'Transform your favourite photo into a stunning personalised comic book cover. You become the hero of your own story.', accentColor: '#EC008C', tags: ['personalised', 'cover'], sortOrder: 1, isPersonalised: true },
    { title: 'Your Portrait as a Pop Icon', slug: 'personalised-icon', category: 'personalised', description: 'We transform your photo into a bold, graphic pop-art icon in the style of the greats. Totally unique, totally you.', accentColor: '#FFF200', tags: ['personalised', 'icon'], sortOrder: 2, isPersonalised: true },
    { title: 'Your Life as a Comic Strip', slug: 'personalised-strip', category: 'personalised', description: 'Tell your story panel by panel. We create a bespoke comic strip from your photos, capturing your moments in comic book glory.', accentColor: '#00AEEF', tags: ['personalised', 'strip'], sortOrder: 3, isPersonalised: true },
  ];

  for (const p of products) {
    await client.create({
      _type: 'product',
      title: p.title,
      slug: { _type: 'slug', current: p.slug },
      category: p.category,
      description: p.description,
      accentColor: p.accentColor,
      tags: p.tags,
      featured: false,
      isPersonalised: p.isPersonalised || false,
      sortOrder: p.sortOrder,
      images: [], // Add images via Studio after seeding
    });
  }
  console.log(`✓ ${products.length} Products (add images via Studio)`);

  // ─── Blog Posts ────────────────────────────────────────────
  const posts = [
    { title: 'What Is Pop Art Wall Art and Why Is It Perfect for Your Home?', slug: 'what-is-pop-art-wall-art', date: '2026-03-15', category: 'inspiration', excerpt: 'From Andy Warhol to your living room — we explore the history of pop art and why comic-style wall art is having a massive moment in UK interior design.' },
    { title: 'How to Choose the Right Size Canvas for Your Wall', slug: 'choosing-the-right-size-canvas', date: '2026-03-08', category: 'guide', excerpt: "Don't get caught out by the wrong dimensions. Our complete guide to sizing your wall art correctly, from small gallery pieces to large statement canvases." },
    { title: 'The Ultimate Personalised Gift: Why Comic Book Art is the One', slug: 'personalised-gifts-uk', date: '2026-02-28', category: 'gift-ideas', excerpt: "Looking for a gift that genuinely surprises someone? A personalised comic book canvas might just be the most memorable present you'll ever give." },
    { title: 'Canvas vs Poster Prints: Which Is Right for You?', slug: 'canvas-vs-poster-prints', date: '2026-02-15', category: 'guide', excerpt: 'We break down the differences between our canvas prints and poster prints — quality, price, durability, and which works best in different rooms.' },
  ];

  for (const post of posts) {
    await client.create({
      _type: 'blogPost',
      title: post.title,
      slug: { _type: 'slug', current: post.slug },
      author: 'Comic Strip Canvas Team',
      publishedAt: new Date(post.date).toISOString(),
      category: post.category,
      excerpt: post.excerpt,
      body: [
        {
          _type: 'block',
          _key: Math.random().toString(36).slice(2),
          style: 'normal',
          children: [
            {
              _type: 'span',
              _key: Math.random().toString(36).slice(2),
              text: 'Blog content coming soon. Edit this post in Sanity Studio to add your full article.',
              marks: [],
            },
          ],
          markDefs: [],
        },
      ],
    });
  }
  console.log(`✓ ${posts.length} Blog Posts (add body content via Studio)`);

  console.log('\n✅ Seeding complete! Open Sanity Studio to add images and edit content.');
}

seed().catch(console.error);
