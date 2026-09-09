import React from 'react';
import { Badge, Box, Card, Flex, Inline, Stack, Text } from '@sanity/ui';
import { useFormValue } from 'sanity';

/**
 * Read-only summary at the top of a pendingPersonalisation: the rendered proof,
 * and directly beneath it the state a reviewer needs before deciding — status,
 * and whatever went wrong if anything did.
 *
 * The proof is served by netlify/functions/personalisation-proof.mjs, which
 * takes the unguessable document id as its access control, so the image loads
 * here with no extra auth.
 */

const TONE: Record<string, 'default' | 'primary' | 'positive' | 'caution' | 'critical'> = {
  draft: 'default',
  awaiting_payment: 'default',
  paid: 'primary',
  preparing: 'primary',
  rendered: 'primary',
  approved: 'positive',
  in_production: 'positive',
  dispatched: 'positive',
  on_hold: 'critical',
};

const LABEL: Record<string, string> = {
  draft: 'Draft',
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  preparing: 'Preparing',
  rendered: 'Rendered',
  approved: 'Approved',
  in_production: 'In production',
  dispatched: 'Dispatched',
  on_hold: 'On hold',
};

/* Per-photo styling state. A render cannot start until every panel is done, so
   when a build is sitting still this is usually the reason -- worth showing
   next to the proof rather than making someone open the photos array. */
const STYLE_TONE: Record<string, 'default' | 'primary' | 'positive' | 'caution' | 'critical'> = {
  pending: 'default',
  styling: 'primary',
  done: 'positive',
  failed: 'critical',
};

type PhotoRow = {
  panel?: string;
  styleStatus?: string;
  styleError?: string;
  styledWidth?: number;
  styledHeight?: number;
};

export default function ProofPanel() {
  const status = useFormValue(['status']) as string | undefined;
  const proofUrl = useFormValue(['proofUrl']) as string | undefined;
  const renderError = useFormValue(['renderError']) as string | undefined;
  const holdNote = useFormValue(['holdNote']) as string | undefined;
  const templateId = useFormValue(['templateId']) as string | undefined;
  const printSize = useFormValue(['printSize']) as string | undefined;
  const photos = (useFormValue(['photos']) as PhotoRow[] | undefined) || [];
  const styleSize = useFormValue(['styleSize']) as string | undefined;
  const styleCalls = useFormValue(['styleCalls']) as number | undefined;

  const done = photos.filter((p) => p.styleStatus === 'done').length;
  const failed = photos.filter((p) => p.styleStatus === 'failed');

  return (
    <Stack space={3}>
      <Card border radius={2} overflow="hidden" tone="transparent">
        {proofUrl ? (
          <Box>
            <img
              src={proofUrl}
              alt="Rendered proof"
              style={{ display: 'block', width: '100%', height: 'auto', background: '#fff' }}
            />
          </Box>
        ) : (
          <Box padding={5}>
            <Text align="center" muted size={1}>
              {status === 'on_hold'
                ? 'No proof — the last render did not finish.'
                : 'No proof yet. One appears here once the render job has run.'}
            </Text>
          </Box>
        )}
      </Card>

      <Flex align="center" gap={2} wrap="wrap">
        <Badge tone={TONE[status || ''] || 'default'} fontSize={1} padding={2}>
          {LABEL[status || ''] || status || 'no status'}
        </Badge>
        {templateId && (
          <Inline>
            <Text size={1} muted>{templateId}</Text>
          </Inline>
        )}
        {printSize && (
          <Inline>
            <Text size={1} muted>· {printSize}</Text>
          </Inline>
        )}
      </Flex>

      {photos.length > 0 && (
        <Card padding={3} radius={2} shadow={1} tone={failed.length ? 'critical' : 'transparent'}>
          <Stack space={3}>
            <Flex align="center" gap={2} wrap="wrap">
              <Text size={1} weight="semibold">
                Styling — {done} of {photos.length} done
              </Text>
              {styleSize && <Text size={1} muted>· {styleSize}</Text>}
              {typeof styleCalls === 'number' && (
                <Text size={1} muted>· {styleCalls} model call{styleCalls === 1 ? '' : 's'}</Text>
              )}
            </Flex>
            <Flex gap={2} wrap="wrap">
              {photos.map((p) => (
                <Badge
                  key={p.panel}
                  tone={STYLE_TONE[p.styleStatus || 'pending'] || 'default'}
                  fontSize={1}
                  padding={2}
                >
                  {p.panel}
                  {p.styleStatus === 'done' && p.styledWidth
                    ? ` · ${p.styledWidth}×${p.styledHeight}`
                    : ` · ${p.styleStatus || 'pending'}`}
                </Badge>
              ))}
            </Flex>
            {failed.map((p) => (
              <Text key={p.panel} size={1}>
                {p.panel}: {p.styleError || 'failed'}
              </Text>
            ))}
          </Stack>
        </Card>
      )}

      {renderError && (
        <Card padding={3} radius={2} shadow={1} tone="critical">
          <Stack space={2}>
            <Text size={1} weight="semibold">Render error</Text>
            <Text size={1}>{renderError}</Text>
          </Stack>
        </Card>
      )}

      {holdNote && (
        <Card padding={3} radius={2} shadow={1} tone="caution">
          <Stack space={2}>
            <Text size={1} weight="semibold">On hold</Text>
            <Text size={1}>{holdNote}</Text>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
