import React, { useEffect, useState } from 'react';
import { Box, Button, Card, Flex, Spinner, Stack, Text } from '@sanity/ui';
import { useClient, useFormValue } from 'sanity';
import {
  isFeeLine, isLegacyBuildLine, isStockLine, resolveLineProduct,
} from '../../netlify/functions/_shared/order-print.mjs';

/**
 * "Download print file" for every line on this order.
 *
 * WHY A PANEL RATHER THAN A FIELD ON EACH LINE
 * --------------------------------------------
 * The file is made per line, so the obvious place for the link is inside the
 * line. But an order's lineItems is an array of anonymous objects, and a field
 * component inside one of them cannot see the order's own _id -- which is half
 * of what the link needs. Reading both from the document once, at the top, is
 * shorter than threading the id down into every row.
 *
 * WHY IT LOOKS THINGS UP
 * ----------------------
 * A line stores the print file it was sold with. Every line written before
 * September 2026 stores nothing, because nothing was stamped then -- and this
 * panel read that absence as "no master on this product" and said so against
 * fourteen orders whose products have perfectly good masters. The Bob Marley
 * icon on CSC-1003 is the example: a master, a saved design, and a panel
 * claiming otherwise.
 *
 * So for a line with no stored file the product is resolved the same way the
 * renderer resolves it -- shared rules in _shared/order-print.mjs, not a second
 * copy -- and its CURRENT master is offered. Current, and labelled as such:
 * what a line was sold with is a snapshot, and what the product has today is a
 * different fact. Saying which is which is the whole point of showing it.
 *
 * NO SECRET IN HERE. The Studio bundle is public, so anything pasted into this
 * file is published. The link goes to /admin/print-file/..., behind the Basic
 * Auth edge function, and the page starts the render itself.
 */

type Line = {
  _key?: string;
  productTitle?: string;
  productSlug?: string;
  size?: string;
  sizeKey?: string;
  format?: string;
  quantity?: number;
  printFile?: string;
  buildKind?: string;
  artworkStyle?: string;
  artworkStyleLabel?: string;
};

type Lookup =
  | { state: 'loading' }
  | { state: 'found'; master: string | null; slug: string; title: string; by: string }
  | { state: 'missing' }
  | { state: 'ambiguous'; candidates: string[] };

const ADMIN_ORIGIN = 'https://comicstripcanvas.co.uk';

const PRODUCT = `{
  "slug": slug.current, title,
  "master": printFile.asset->url,
  "fbMaster": fullBleed.printFile.asset->url
}`;

export default function PrintFileLinks() {
  const id = useFormValue(['_id']) as string | undefined;
  const lines = (useFormValue(['lineItems']) as Line[] | undefined) || [];
  const client = useClient({ apiVersion: '2026-04-11' });

  /* A draft carries a drafts. prefix; the renderer reads the published order,
     and the two ids differ by exactly that. */
  const orderId = (id || '').replace(/^drafts\./, '');

  const [lookups, setLookups] = useState<Record<string, Lookup>>({});

  /* Only the lines that need it: a line with its own stored file already knows
     what it was sold with, and a built or fee line has no stock product. */
  const needing = lines
    .map((line, i) => ({ line, key: line._key || String(i) }))
    .filter(({ line, key }) => !line.printFile && isStockLine(line, key));
  const needingKeys = needing.map((n) => n.key).join('|');

  useEffect(() => {
    let live = true;
    if (!needing.length) return undefined;

    setLookups((prev) => {
      const next = { ...prev };
      for (const { key } of needing) if (!next[key]) next[key] = { state: 'loading' };
      return next;
    });

    (async () => {
      for (const { line, key } of needing) {
        const found = await resolveLineProduct({
          line,
          lineKey: key,
          bySlug: (slug: string) =>
            client.fetch(`*[_type == "product" && slug.current == $slug][0]${PRODUCT}`, { slug }),
          byTitle: (title: string) =>
            client.fetch('*[_type == "product" && title == $title]{ "slug": slug.current }', { title }),
        }).catch(() => ({ error: 'lookup failed', reason: 'missing' as const }));

        if (!live) return;
        setLookups((prev) => ({
          ...prev,
          [key]: (found as any).product
            ? {
              state: 'found',
              slug: (found as any).product.slug,
              title: (found as any).product.title,
              by: (found as any).by,
              master: line.artworkStyle === 'fullBleed'
                ? ((found as any).product.fbMaster || null)
                : ((found as any).product.master || null),
            }
            : (found as any).reason === 'ambiguous'
              ? { state: 'ambiguous', candidates: (found as any).candidates || [] }
              : { state: 'missing' },
        }));
      }
    })();

    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needingKeys, client]);

  if (!orderId || lines.length === 0) {
    return (
      <Card padding={3} radius={2} tone="transparent">
        <Text size={1} muted>No lines on this order yet.</Text>
      </Card>
    );
  }

  return (
    <Stack space={3}>
      <Text size={1} muted>
        Made for the size and finish each line was ordered at, including the canvas
        wrap. The first build of a line takes up to half a minute; after that it is
        kept until the product’s artwork changes.
      </Text>

      {lines.map((line, i) => {
        const key = line._key || String(i);
        const built = Boolean(line.buildKind) || isLegacyBuildLine(line, key);
        const fee = isFeeLine(line);
        const href = `${ADMIN_ORIGIN}/admin/print-file/${encodeURIComponent(orderId)}/${encodeURIComponent(key)}`;
        const detail = [line.artworkStyleLabel, line.format, line.size]
          .filter(Boolean).join(' · ');
        const look = lookups[key];

        return (
          <Card key={key} padding={3} radius={2} shadow={1} tone={built || fee ? 'transparent' : 'default'}>
            <Flex align="center" gap={3} wrap="wrap">
              <Box flex={1}>
                <Text size={2} weight="semibold">
                  {line.productTitle || 'Line'}{line.quantity && line.quantity > 1 ? ` × ${line.quantity}` : ''}
                </Text>
                <Box marginTop={1}>
                  <Text size={1} muted>{detail || '—'}</Text>
                </Box>
              </Box>

              {built ? (
                <Text size={1} muted>
                  Built by the customer — printed from the proof on its Personalisations entry.
                </Text>
              ) : fee ? (
                <Text size={1} muted>Not a printable line.</Text>
              ) : (
                <Flex gap={2} align="center">
                  <Button
                    as="a"
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    text="Download print file"
                    tone="primary"
                    fontSize={1}
                    padding={3}
                  />
                  <MasterLink line={line} look={look} />
                </Flex>
              )}
            </Flex>
          </Card>
        );
      })}
    </Stack>
  );
}

/**
 * The master, and where it came from.
 *
 * Three different facts, kept apart on purpose:
 *   sold with   the line's own snapshot. What was bought.
 *   current     the product's master today, for a line that never stored one.
 *   none        the product genuinely has no master -- the only case that is
 *               actually a problem, and the only one that says so.
 */
function MasterLink({ line, look }: { line: Line; look?: Lookup }) {
  if (line.printFile) {
    return (
      <Button
        as="a"
        href={line.printFile}
        target="_blank"
        rel="noreferrer"
        text="Master (as sold)"
        mode="ghost"
        fontSize={1}
        padding={3}
      />
    );
  }

  if (!look || look.state === 'loading') {
    return (
      <Flex align="center" gap={2}>
        <Spinner muted />
        <Text size={1} muted>Finding the product…</Text>
      </Flex>
    );
  }

  if (look.state === 'ambiguous') {
    return (
      <Text size={1} style={{ color: '#f03e2f' }}>
        Ambiguous — {look.candidates.length} products share this title
        {look.candidates.length ? ` (${look.candidates.join(', ')})` : ''}. Print from the product.
      </Text>
    );
  }

  if (look.state === 'missing') {
    return <Text size={1} muted>Product not found — print from the product itself.</Text>;
  }

  if (!look.master) {
    return <Text size={1} style={{ color: '#f03e2f' }}>No master on this product</Text>;
  }

  return (
    <Flex align="center" gap={2}>
      <Button
        as="a"
        href={look.master}
        target="_blank"
        rel="noreferrer"
        text="Master (current)"
        mode="ghost"
        fontSize={1}
        padding={3}
      />
      <Text size={1} muted>{look.slug}</Text>
    </Flex>
  );
}
