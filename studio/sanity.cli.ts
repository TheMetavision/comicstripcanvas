import { defineCliConfig } from 'sanity/cli';

export default defineCliConfig({
  api: {
    projectId: 'lwbwahym',
    dataset: 'production',
  },
  // Pin the deploy target. Without this `sanity deploy` prompts for a hostname,
  // which cannot be answered in CI and risks publishing a second studio under a
  // new name. This is the studio already live at comicstripcanvas.sanity.studio.
  studioHost: 'comicstripcanvas',
});
