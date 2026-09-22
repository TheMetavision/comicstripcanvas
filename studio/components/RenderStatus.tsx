import React, { useEffect, useState } from 'react';
import { Box, Card, Flex, Spinner, Stack, Text } from '@sanity/ui';
import { useFormValue } from 'sanity';

/**
 * "Rendering… don't publish yet."
 *
 * A studio render does not write to the published document. It attaches the
 * artwork to the DRAFT, and publishing is what promotes it. So publishing while
 * a render is still going produces a published product built from what was
 * there BEFORE it — the new artwork stranded in a draft nobody looks at, the
 * live page showing the old picture, and nothing anywhere saying so.
 *
 * Adam & The Ants went out that way by six seconds. It took reading blob write
 * trails to work out why, because every layer downstream was behaving
 * correctly: the page matched the document, the document matched what had been
 * published, and the publish had simply happened first.
 *
 * studio-save stamps renderStartedAt when it hands off to the renderer, and the
 * renderer clears it once the pictures are attached. While it is set, a render
 * is in flight and this says so where the Publish button is.
 *
 * It does not BLOCK publishing. Someone who knows what they are doing may have
 * a reason, and a Studio that refuses an action without being able to explain
 * itself is worse than one that warns.
 */

/* Past this, a render is not slow, it is gone. The longest legitimate render
   observed is a little over a minute; the function's own ceiling is 15. Five
   minutes is comfortably past "still working" and well short of the timeout,
   so it catches a dead render without crying wolf over a slow one. */
const STALE_AFTER_MS = 5 * 60 * 1000;

function ago(ms: number): string {
  if (ms < 1000) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

export default function RenderStatus() {
  const startedAt = useFormValue(['renderStartedAt']) as string | undefined;
  const sceneId = useFormValue(['classicSceneId']) as string | undefined;
  const docId = useFormValue(['_id']) as string | undefined;

  /* Ticks so the elapsed time is live rather than frozen at whatever it was
     when the form mounted -- the whole point is watching it. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  if (!startedAt) return null;

  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) {
    return (
      <Card padding={3} radius={2} shadow={1} tone="caution">
        <Text size={1}>A render was started but its timestamp is unreadable ({String(startedAt)}).</Text>
      </Card>
    );
  }

  const elapsed = Math.max(0, now - started);
  const stale = elapsed > STALE_AFTER_MS;
  const id = (sceneId || String(docId || '').replace(/^drafts\./, '')) || '<id>';

  return (
    <Card padding={4} radius={2} shadow={1} tone={stale ? 'critical' : 'caution'}>
      <Flex align="flex-start" gap={3}>
        {!stale && <Box marginTop={1}><Spinner muted /></Box>}
        <Stack space={3}>
          <Text size={2} weight="semibold">
            {stale ? 'This render has not finished' : 'Rendering… don’t publish yet'}
          </Text>

          {!stale ? (
            <Text size={1} muted>
              The artwork is still being made. It attaches to the <strong>draft</strong>, and publishing
              before it lands would publish the previous picture and leave the new one stranded.
              Started {ago(elapsed)}.
            </Text>
          ) : (
            <Stack space={2}>
              <Text size={1}>
                Started {ago(elapsed)} and nothing has attached. A render normally takes under two
                minutes, so this one has most likely failed — the function is a background one and
                a failure leaves no trace on the document.
              </Text>
              <Text size={1} muted>
                Run it again from the scene that is already saved — nothing has to be rebuilt:
              </Text>
              <Card padding={2} radius={1} tone="default">
                <Text size={1} style={{ fontFamily: 'monospace' }}>
                  POST /api/studio-render/{id}
                </Text>
              </Card>
              <Text size={1} muted>
                Or run <code>node tools/builder/render-sweep.mjs</code> to see every render in this
                state across the catalogue.
              </Text>
            </Stack>
          )}
        </Stack>
      </Flex>
    </Card>
  );
}
