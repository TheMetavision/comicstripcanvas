import { createClient } from '@sanity/client';

// ── CONFIG ──────────────────────────────────────────────────────────────────
const YOUR_SANITY_API_TOKEN = 'skOTRdqrs3Cdo23E3ixW08Q60clT16BoHMjkKOvVASUlK2Vs1s29p6NBFcsaUQPAMYKPrR9o2ZNrgyG7n0JNroJl9MEHfp4ok6p0nPFrW48ZfAUp1kH4Y9f6Nb6yyKJuUWJuv2PYwjpQJIK8dNniPWfdKJRkfKL3TSVEodP3Ftpsq1uhHQix'; // paste your token here

const client = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  useCdn: false,
  apiVersion: '2024-01-01',
  token: YOUR_SANITY_API_TOKEN,
});

// ── MARKDOWN → PORTABLE TEXT ─────────────────────────────────────────────────
let keyCounter = 0;
function key() { return `k${++keyCounter}`; }

function parseInline(text) {
  const spans = [];
  const regex = /\*\*(.*?)\*\*/g;
  let last = 0, match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) spans.push({ _key: key(), _type: 'span', text: text.slice(last, match.index), marks: [] });
    spans.push({ _key: key(), _type: 'span', text: match[1], marks: ['strong'] });
    last = match.index + match[0].length;
  }
  if (last < text.length) spans.push({ _key: key(), _type: 'span', text: text.slice(last), marks: [] });
  return spans.length ? spans : [{ _key: key(), _type: 'span', text, marks: [] }];
}

function markdownToPortableText(md) {
  const blocks = [];
  const lines = md.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trimEnd();

    if (!line.trim()) { i++; continue; }

    if (/^# /.test(line)) { i++; continue; }

    if (/^## /.test(line)) {
      blocks.push({ _key: key(), _type: 'block', style: 'h2', children: [{ _key: key(), _type: 'span', text: line.replace(/^## /, ''), marks: [] }], markDefs: [] });
      i++; continue;
    }

    if (/^### /.test(line)) {
      blocks.push({ _key: key(), _type: 'block', style: 'h3', children: [{ _key: key(), _type: 'span', text: line.replace(/^### /, ''), marks: [] }], markDefs: [] });
      i++; continue;
    }

    if (/^\|/.test(line)) {
      if (/^\|[\s\-|]+\|$/.test(line)) { i++; continue; }
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      const text = cells.join(' — ');
      blocks.push({ _key: key(), _type: 'block', style: 'normal', children: parseInline(text), markDefs: [] });
      i++; continue;
    }

    if (/^[-*] /.test(line)) {
      blocks.push({ _key: key(), _type: 'block', style: 'normal', listItem: 'bullet', level: 1, children: parseInline(line.replace(/^[-*] /, '')), markDefs: [] });
      i++; continue;
    }

    if (/^\d+\. /.test(line)) {
      blocks.push({ _key: key(), _type: 'block', style: 'normal', listItem: 'number', level: 1, children: parseInline(line.replace(/^\d+\. /, '')), markDefs: [] });
      i++; continue;
    }

    let paragraphLines = [];
    while (i < lines.length && lines[i].trim() && !/^[#|]/.test(lines[i]) && !/^[-*] /.test(lines[i]) && !/^\d+\./.test(lines[i])) {
      paragraphLines.push(lines[i].trim());
      i++;
    }
    if (paragraphLines.length) {
      const text = paragraphLines.join(' ');
      blocks.push({ _key: key(), _type: 'block', style: 'normal', children: parseInline(text), markDefs: [] });
    }
  }

  return blocks;
}

// ── ARTICLE CONTENT ──────────────────────────────────────────────────────────

const articles = {
  // "What Is Pop Art Wall Art"
  KpYSwvFDOc0m4VLTD8arQH: `
## The Origins of Pop Art

Pop art emerged in the 1950s and 1960s as a reaction against the seriousness of abstract expressionism. Artists like Andy Warhol, Roy Lichtenstein, and Peter Blake took their inspiration from the most visible elements of everyday life — advertising, celebrity, consumer culture, and mass media — and turned them into high art.

Roy Lichtenstein's bold comic-strip panels, complete with Ben-Day dot printing effects and thick black outlines, became some of the most recognisable images of the 20th century. Warhol's repeated screenprints of Marilyn Monroe and Elvis Presley asked the question: if something is reproduced enough times, does it become more iconic or less? The answer, it turned out, was more.

## Why Pop Art Works on Your Wall

Pop art wall art does something that most art fails to do — it creates immediate recognition and emotional response. When you hang a bold graphic print of a figure who matters to you — a sporting hero, a film icon, a music legend — it doesn't just decorate a room. It starts conversations.

The visual language of pop art is deliberately accessible. The thick outlines, vivid block colours, and simplified graphic forms make every piece immediately legible, even from across a room. That's the opposite of much contemporary art, which often rewards prolonged close study rather than impact at distance.

For UK homes — which tend toward smaller rooms and feature walls rather than gallery-scale spaces — this instant visual impact is particularly well-suited. A well-chosen pop art canvas on a chimney breast or at the end of a hallway can completely transform the character of a room.

## Comic-Style Wall Art: Pop Art's Natural Evolution

Comic book aesthetics take pop art's visual principles and push them further. Where Lichtenstein referenced comic strips as an artistic statement, comic-style wall art celebrates the iconography directly — putting the heroes, legends, and moments of sport, film, and music into a format that feels bold, dynamic, and genuinely joyful.

At Comic Strip Canvas, every design is made to order in the UK using exactly these principles — bold graphic lines, vivid colour palettes, and compositions built to command attention from across the room. Whether it's a football legend immortalised as a magazine cover star, a film icon rendered in three unforgettable panels, or a personalised portrait transformed into comic art, the result is wall art that earns its place every time.

## Pop Art Wall Art and UK Interior Design

The UK interior design trend of the mid-2020s has moved decisively away from the minimalist grey-and-white aesthetic that dominated the previous decade. Colour is back. Personality is back. Art that reflects who you are — not just a neutral backdrop — is what people are looking for.

Pop art wall art sits perfectly at the intersection of these trends. It's bold without being aggressive, recognisable without being generic, and personal without requiring custom production — unless you want it to be, in which case a personalised comic art commission delivers exactly that.

## How to Style Pop Art Wall Art at Home

**Feature walls** are the natural home for a bold graphic print. A single large canvas on a chimney breast or the wall behind a sofa creates a focal point that gives the whole room a character reference point.

**Gallery walls** work well with smaller pieces — three or four prints from the same range create a collected feel rather than a single statement.

**Home offices and games rooms** are the natural territory for sport and film icons — spaces where personality is expected and bold art fits the energy of the room.

**Gifting** is where pop art wall art has found its biggest growth audience. A canvas featuring someone's hero — their sporting legend, their favourite film, their music icon — is a genuinely original gift that outlasts any card, bottle, or voucher.

## Ready to Find Your Icon?

Browse the Comic Book Icons range, explore the Comic Book Strips collection, or go fully personal with a commission from your own photo. Every piece is made to order in the UK, printed on canvas or 260gsm photo paper, and dispatched with free P&P to UK mainland addresses. Bold, vivid, and built to last.
`,

  // "How to Choose the Right Size Canvas"
  htrMui7M7v6ADvapqduV5L: `
## The Comic Strip Canvas Size Options

Every design in the Comic Strip Canvas range is available in three sizes:

- **Small — 12x8 inches** — ideal for smaller walls, desk displays, gallery wall arrangements, and gifting
- **Medium — 16x12 inches** — the most versatile option; works well on most standard walls and in most rooms
- **Large — 24x16 inches** — the statement piece; built for feature walls, chimney breasts, and rooms where you want the art to anchor the space

Each size is available as a poster print (from £9.99) or on canvas — either standard frame (from £26.99) or gallery frame (from £28.99).

## Matching Size to Wall Space

**For feature walls and chimney breasts:** go Large. These are the walls that carry the room, and small art on a large wall looks hesitant. A 24x16" canvas on a chimney breast creates a proper focal point — the kind that earns the first comment from anyone who walks in.

**For above a sofa or bed:** Medium to Large. The standard rule of thumb is that art should occupy around two-thirds of the furniture width below it. Above a standard three-seat sofa, a medium canvas is the minimum.

**For smaller rooms and alcoves:** Small to Medium. A small canvas in an alcove or on a narrow wall beside a door can work beautifully — it's about scale relative to the space, not the room's overall size.

**For gallery walls:** mix Small and Medium. Gallery walls work best when they create a sense of curated collection. Three or four pieces of varying sizes in a loose grid or staggered arrangement creates a collected feel that a single large piece can't replicate.

**For home offices and desk areas:** Small. A small canvas above a monitor or on a shelf works at desk height and close range in a way that large art often doesn't.

## Canvas vs Poster: Does Size Affect the Choice?

At every size, you can choose between poster print and canvas. Poster prints are printed on 260gsm photo paper and need a standard frame (not included). Canvas prints are stretched on a wooden frame and ready to hang straight from the box — either standard frame or gallery frame (deeper, more prominent display).

## The Gifting Size Question

If you're buying a canvas as a gift and you're not certain of the space it's going to, **Medium** is almost always the right call. It's substantial enough to feel like a proper gift but versatile enough to work in almost any room without needing to match a specific wall.

For personalised commissions, think about where the recipient is most likely to display it. A gift for a home office suggests Small. A gift for a main living room or bedroom suggests Medium or Large.

## Quick Reference

**Small (12x8")** — poster from £9.99, canvas from £26.99. Best for gallery walls, gifting, desk or shelf display.

**Medium (16x12")** — poster from £12.99, canvas from £31.99. Best for most rooms and most walls — the versatile option.

**Large (24x16")** — poster from £16.99, canvas from £44.99. Best for feature walls, chimney breasts, statement pieces.

All orders include free P&P to UK mainland addresses. Browse the full range across Comic Book Icons, Comic Book Strips, Comic Book Covers, or start a personalised commission.
`,

  // "The Ultimate Personalised Gift"
  htrMui7M7v6ADvapqduVOx: `
## It's Genuinely Unique

The thing about a personalised comic book portrait is that no one else has one. Not a version of it. Not something similar. The specific combination of that person's face, rendered in bold comic-book style, in the format you choose, with the composition built around your photo — it exists nowhere else. It is, in the truest sense, made for them.

This matters more than people realise. The gift that someone keeps for thirty years isn't usually the most expensive one. It's the one that proves someone actually thought about who they are.

## The Three Formats — Which Is Right?

**Personalised Comic Book Cover** — your subject as the star of a bold, vintage-style comic book cover. Dynamic, graphic, and immediately striking. The personalisation fee is £10 on top of the standard canvas or poster price.

**Personalised Comic Book Icon** — a portrait transformed into a striking pop-art graphic icon — bold colour, strong graphic form, and the visual language of the legends in the curated range. Also £10 personalisation fee.

**Personalised Comic Book Strip** — the most ambitious format. Three panels that tell a story. This is the right choice for someone whose life has chapters worth capturing: the sport they played, the moment they had, the journey they've been on. At £25 personalisation fee, it's the premium option — and it shows.

## Who It's For

Personalised comic art works as a gift for almost anyone — but it's best for:

- **Dads** — sport, film, and music passions are all natural subject matter. Father's Day is the biggest gifting window for exactly this reason.
- **Milestone birthdays** — a 40th, 50th, or 60th gift that captures who someone is, not just how old they're turning.
- **Partners** — romantic but not generic. A personalised portrait says "I know who you are" in a way that flowers don't.
- **Sports fans** — your player, your jersey, your moment on a canvas.
- **Anyone who's achieved something worth marking** — a graduation, a career moment, a personal milestone.

## The Process — Simpler Than You'd Think

1. Visit the personalise page and choose your style — Cover, Icon, or Strip
2. Upload your photo — a clear, well-lit photo with a visible face works best
3. Add your details — any notes on style, colours, or specific elements you want included
4. We send your proof within 24–48 hours — you review it and request changes until it's right
5. We print and dispatch within 3–6 working days — free P&P to UK mainland

The proof stage is important. Nothing goes to print until you've seen it and approved it. If you want changes, you ask for them. The finished piece should be something you're proud to give.

## Pricing

Personalised commissions use the same base pricing as the curated range, with a personalisation fee on top. Canvas prints start from £26.99 for standard frame, £28.99 for gallery frame. Poster prints from £9.99. Personalisation fee: +£10 for Covers and Icons, +£25 for Strips.

## Ordering in Time

For personalised commissions, allow at least 10 days from order to arrival to be comfortable. For Father's Day (21 June), order by approximately 7 June. Standard prints without personalisation dispatch within 3–6 working days with no proof stage required.

Every piece made to order in the UK. Free P&P to UK mainland addresses. KA-POW.
`,

  // "Canvas vs Poster Prints"
  KpYSwvFDOc0m4VLTD8arjd: `
## What's the Difference?

**Poster prints** are printed on 260gsm photo paper — heavier than standard printing paper, with a quality finish that holds colour well and looks sharp at any size. A poster print needs a frame to be displayed (not included) and is available in Small, Medium, and Large.

**Canvas prints** are printed on 410gsm canvas material, stretched and wrapped around a solid wooden frame — ready to hang straight from the box, no frame required. Two canvas options: standard frame and gallery frame (deeper frame, more prominent display).

## The Honest Price Comparison

**Small size:** Poster £9.99 — Canvas standard £26.99 — Canvas gallery £28.99

**Medium size:** Poster £12.99 — Canvas standard £31.99 — Canvas gallery £33.99

**Large size:** Poster £16.99 — Canvas standard £44.99 — Canvas gallery £46.99

The canvas premium is real — roughly 3x the poster price. What you're paying for is the material quality, the ready-to-hang presentation, and the visual weight on the wall.

## When to Choose Poster

**You want to frame it yourself.** If you have a specific frame in mind — something that matches your room, a vintage find, a frame that complements other pieces on the wall — a poster print gives you that flexibility. The standard sizes fit most off-the-shelf frames.

**You're trying the range.** A poster print at £9.99 is a low-stakes way to see how a design looks in your space before committing to canvas. Some people order a poster first, love it, and upgrade to canvas later.

**Budget is the priority.** Poster prints are excellent quality at their price point. If the choice is between a medium poster and nothing at all, the medium poster is absolutely worth it.

**It's going in a frame-heavy gallery wall.** Gallery walls where every piece is framed can look more cohesive when everything is framed consistently — and poster prints give you control over the frame style.

## When to Choose Canvas

**You want it ready to hang.** Canvas prints come with everything needed for display. No trip to a framer, no frame to source, no measuring required. Open the box, find the hook, done.

**It's a gift.** Canvas is the more premium presentation — the one that feels like a proper gift rather than a print you'd pick up at a market. If you're buying for someone else, canvas is almost always the right call.

**You want maximum visual impact.** At large size, the canvas format adds genuine physical presence to a design — the depth of the frame, the texture of the canvas material, and the ready-hung presentation all contribute to a more substantial wall piece.

**It's going on a feature wall.** A feature wall deserves canvas. A poster in a standard frame on a feature wall can work, but it rarely commands the space the way a gallery-frame canvas does.

## Gallery Frame vs Standard Frame

If you've decided on canvas, the final choice is standard or gallery frame. **Standard frame** is the right choice for most situations — solid, well-made, looks excellent on any wall. **Gallery frame** has a deeper profile, projects further from the wall, and creates more shadow around the edges — adding definition and presence. Worth the extra £2 for large feature wall pieces.

## The Short Answer

**Choose poster if:** you want to frame it yourself, you're on a tighter budget, or you're adding to a framed gallery wall.

**Choose canvas if:** you want ready-to-hang, you're giving it as a gift, or it's going on a feature wall where visual impact matters.

Browse the full range and choose your format at checkout — every design available in all formats and sizes, made to order in the UK, with free P&P to UK mainland addresses.
`
};

// ── PATCH DOCUMENTS ──────────────────────────────────────────────────────────

async function patchAll() {
  for (const [id, markdown] of Object.entries(articles)) {
    console.log(`\nPatching ${id}...`);
    const body = markdownToPortableText(markdown.trim());
    try {
      await client.patch(id).set({ body }).commit();
      console.log(`  ✅ Done`);
    } catch (err) {
      console.error(`  ❌ Failed:`, err.message);
    }
  }

  // ── CREATE FATHER'S DAY POST ──────────────────────────────────────────────
  console.log('\nCreating Father\'s Day blog post...');
  const fdBody = markdownToPortableText(`
## For the Football Dad

Every football dad has an icon who made him fall in love with the game. The goal that made him leap off the sofa. The player who made football look like art. That's the starting point for his Father's Day gift.

**The Maradona Comic Book Icon** is the one for dads who watched the Hand of God and still argue about it forty years later. Rendered in bold comic-book style with vivid colours and graphic impact — this is not a poster. It's a statement. Diego Maradona reimagined as the icon he was, in a format that demands attention. Available from £9.99 as a poster print, or from £26.99 on canvas.

**The Messi Comic Book Icon** is for the dad who's been watching Messi with the same awe for twenty years and still can't quite believe what he's seen. Bold lines, vivid colour, and a design that captures the quality of a career that no one will ever quite repeat.

And if his dad raised him on a specific club, a specific era, a specific moment — that's where a personalised football commission becomes the gift that no one else will think of. Upload a photo from a match day, a moment he's told you about, a kit he wore on a Sunday morning — and we'll turn it into his own Comic Book Icon. His face. His moment. His wall.

Sport Comic Strips — multi-panel artworks capturing the career of a football legend across three defining moments — are coming to the range soon. Watch this space.

## For the Film Dad

Film dads are a specific breed. They have a film they've watched a hundred times and will happily watch again. They have quotes for every situation. They have strong opinions about sequels. And they almost certainly do not have this on their wall.

**The Comic Book Strips range** is made for them. Unlike a standard print, each Strip tells the story — three hand-crafted panels that capture the energy, the humour, and the iconic moments of a cult classic in bold, vivid comic-book style.

**Back to the Future** — for the dad who still calculates what year the DeLorean would be heading to. Three panels. Great Scott.

**Ghostbusters** — for the dad who introduced you to it as a child and has never stopped being slightly proud of himself for doing so.

**Gremlins** — for the dad who made watching it a Christmas tradition before you were old enough to understand that probably wasn't appropriate.

Every Strip is made to order in the UK, available as a poster print from £9.99 or on canvas from £26.99. For the film dad who has a very specific favourite, a Personalised Comic Book Cover puts him in the story. His face. His film. His wall. The kind of gift you'll find him showing to people for years.

## For the Music Dad

Some dads measure their lives in albums. Their music collection is sacred. Their favourite artist is non-negotiable. The Comic Book Icons range celebrates music legends in the same bold graphic style that makes every design unmistakable from across the room. If the music shapes the man, the art can shape the wall.

And if his icon isn't in the current range — or if he has a favourite gig, a specific moment, a photograph that captures exactly who he is as a music fan — a personalised commission turns that into something made just for him.

## The Ultimate Father's Day Gift — Make Him the Hero

Here's the thing about knowing exactly who your dad is: you also know that no print in the world will be more perfect for him than one with his face on it. That's what a personalised Comic Strip Canvas commission is — not a novelty gift, but a genuinely made, hand-illustrated piece of comic art built around the person who means the most to you.

**Personalised Comic Book Cover** — his face, the design he loves, the colours and composition built around a photo you upload, turned into comic-book cover art that belongs on his wall and nowhere else.

**Personalised Comic Book Strip** — three panels, his story. Made to order in the UK, in bold graphic style. From £26.99 on canvas, plus £25 for personalisation.

The process is straightforward: choose your style, upload your photo, and we'll send you a proof within 24–48 hours. Once you approve it, production and UK delivery takes 3–6 working days.

## Ordering in Time for Father's Day

Father's Day 2026 is Sunday 21 June.

**Standard prints** (poster and canvas) dispatch within 3–6 working days. Order by approximately 13 June for safe Father's Day delivery to UK mainland addresses.

**Personalised commissions** — allow 24–48 hours for your proof, then 3–6 working days for production and dispatch. Order by approximately 7 June to be safe.

All orders include free P&P to UK mainland. Start your commission at the personalise page.
`.trim());

  try {
    const doc = await client.create({
      _type: 'blogPost',
      title: "Father's Day Gifts for Dads Who Love Sport, Film and Music — Ranked by KA-POW Factor",
      slug: { _type: 'slug', current: 'fathers-day-gift-ideas-sport-film-music-uk' },
      excerpt: "Your dad has a legend. A footballer, a film, a musician who shaped him. Here's the gift that proves you know who it is — bold, vivid, made-to-order comic art that belongs on his wall.",
      publishedAt: '2026-05-05T00:00:00.000Z',
      body: fdBody,
    });
    console.log(`  ✅ Father's Day post created: ${doc._id}`);
  } catch (err) {
    console.error(`  ❌ Failed:`, err.message);
  }

  console.log('\n✅ All done. Sanity webhook will trigger a Netlify rebuild automatically.');
}

patchAll();
