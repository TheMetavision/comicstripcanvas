import React from 'react';
import { Card, Stack, Text } from '@sanity/ui';
import { useFormValue } from 'sanity';

/**
 * The customer's own design, as a reviewer needs to see it: when it was kept,
 * and a link to the proof they designed.
 *
 * Replaces the object's default input, which would print the recipe JSON and
 * the scene SVG in full -- tens of kilobytes of markup nobody reads in a form,
 * and the one thing that IS worth looking at is the picture.
 *
 * The link goes to /admin/api/personalisation-scene/<ref>/original-proof, behind
 * the Basic Auth edge function, the same address the admin page links to. NO
 * SECRET IN HERE: the Studio bundle is public.
 */

const ADMIN_ORIGIN = 'https://comicstripcanvas.co.uk';

export default function CustomerOriginalPanel() {
  const id = useFormValue(['_id']) as string | undefined;
  const savedAt = useFormValue(['customerOriginal', 'savedAt']) as string | undefined;
  const scene = useFormValue(['customerOriginal', 'sceneSvg']) as string | undefined;

  /* The build's ref out of whatever id the Studio is showing: published
     (pendingPersonalisation.pp-...) or a draft of it (drafts.pendingPersonalisation.pp-...). */
  const ref = (id || '').match(/pp-[0-9a-f]{32}/)?.[0];

  if (!scene) {
    return (
      <Card padding={3} radius={2} tone="transparent">
        <Text size={1} muted>Not edited by us — this is still entirely the customer’s design.</Text>
      </Card>
    );
  }

  return (
    <Card padding={3} radius={2} shadow={1}>
      <Stack space={3}>
        <Text size={1}>
          Kept {savedAt ? new Date(savedAt).toLocaleString('en-GB') : 'at an unknown time'}, the first
          time we edited it. Never overwritten afterwards.
        </Text>
        {ref && (
          <Text size={1}>
            <a
              href={`${ADMIN_ORIGIN}/admin/api/personalisation-scene/${ref}/original-proof`}
              target="_blank"
              rel="noreferrer"
            >
              View the proof they designed
            </a>
          </Text>
        )}
      </Stack>
    </Card>
  );
}
