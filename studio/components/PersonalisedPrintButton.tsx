import React, { useEffect, useState } from 'react';
import { Button, Flex, Spinner, Stack, Text } from '@sanity/ui';
import { printPanelState } from '../../netlify/functions/_shared/personalised-print.mjs';

/**
 * "Download print file" for one personalised build, wherever the Studio shows
 * one: the build's own Personalisations entry and the order it was paid on.
 *
 * The rules -- approved yet? current? -- are _shared/personalised-print.mjs,
 * the same file the download route enforces, read here off what the render
 * recorded on the build (doc.printFile). The Studio cannot read the blob store,
 * so the route has the last word and refuses anything this gets wrong.
 *
 * Both links are top-level navigations to /admin, for the reason given in
 * personalisationActions.tsx: a cross-origin fetch carries no Basic Auth and a
 * 401 on one prompts nobody. Opening the address does prompt, and then the
 * file simply downloads. NO SECRET IN HERE -- the bundle is public.
 */

const SITE =
  (import.meta as any).env?.SANITY_STUDIO_SITE_URL || 'https://comicstripcanvas.co.uk';

export type PrintBuild = {
  _id?: string;
  status?: string;
  recipe?: string;
  sceneSvg?: string;
  editedAt?: string;
  editCount?: number;
  printFile?: Record<string, any>;
  printError?: string;
  printSize?: string;
  templateId?: string;
  outputFormat?: string;
  orderNumber?: string;
};

type State = Awaited<ReturnType<typeof printPanelState>>;

export default function PersonalisedPrintButton({ build }: { build: PrintBuild }) {
  const [state, setState] = useState<State | null>(null);
  const ref = (build._id || '').match(/pp-[0-9a-f]{32}/)?.[0] || '';

  useEffect(() => {
    let live = true;
    printPanelState(build).then((s) => { if (live) setState(s); }).catch(() => {
      if (live) setState({ state: 'unrecorded', why: 'Could not check this print here; the download checks it.', size: '' });
    });
    return () => { live = false; };
    /* The fields the decision reads. A new render changes printFile; an edit
       changes recipe/sceneSvg; approval changes status. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build.status, build.recipe, build.sceneSvg, build.editedAt, build.editCount, build.printFile?.fingerprint]);

  if (!ref) return null;
  if (!state) {
    return (
      <Flex align="center" gap={2}><Spinner muted /><Text size={1} muted>Checking the print file…</Text></Flex>
    );
  }

  const admin = `${SITE}/admin/personalisation/${ref}`;
  return (
    <Stack space={2}>
      {state.state === 'awaiting' ? (
        <Text size={1} muted>{state.why}</Text>
      ) : state.state === 'ready' || state.state === 'unrecorded' ? (
        <Flex align="center" gap={3} wrap="wrap">
          <Button
            as="a"
            href={`${admin}/print`}
            target="_blank"
            rel="noreferrer"
            text="Download print file"
            tone="primary"
            fontSize={1}
            padding={3}
          />
          {state.size && <Text size={1} muted>{state.size}</Text>}
        </Flex>
      ) : (
        <Stack space={2}>
          <Text size={1} style={{ color: '#f03e2f' }}>{state.why}</Text>
          <Flex>
            <Button
              as="a"
              href={`${admin}?action=rerender-print`}
              target="_blank"
              rel="noreferrer"
              text="Re-render print file…"
              tone="caution"
              mode="ghost"
              fontSize={1}
              padding={3}
            />
          </Flex>
        </Stack>
      )}
      {state.state === 'unrecorded' && <Text size={0} muted>{state.why}</Text>}
      {build.printError && (
        <Text size={1} style={{ color: '#f03e2f' }}>Last print re-render failed: {build.printError}</Text>
      )}
    </Stack>
  );
}
