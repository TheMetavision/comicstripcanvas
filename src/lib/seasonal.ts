/* Seasonal campaign (Site Settings > Seasonal campaign), read at build time.

   The site is static, so the build only decides whether seasonal markup
   exists at all: it does when the campaign is on and has not yet ended. The
   start/end window itself is checked in the browser by the head script in
   BaseLayout, which sets <html data-season="on">; CSS then shows .season-on
   and hides .season-off. So a campaign starts and stops on its dates without
   a rebuild, and with no campaign the pages carry nothing seasonal. */
import { sanityClient } from './sanity';
import { siteSettingsQuery } from './queries';

export interface SeasonalImage {
  url: string;
  width?: number;
  height?: number;
  hotspot?: { x: number; y: number };
}

export interface SeasonalCampaign {
  label?: string;
  startDate: string;
  endDate: string;
  heroImageDesktop: SeasonalImage;
  heroImageMobile?: SeasonalImage;
  heroImageAlt: string;
  eyebrow?: string;
  headlineLine1?: string;
  headlineLine2?: string;
  body?: string;
  snow: boolean;
  snowCap: boolean;
}

interface SeasonalState {
  campaign: SeasonalCampaign | null;
  /** Whether AnnouncementBar renders, so the hero knows if the bar's snow cap sits on its top edge. */
  announcementShown: boolean;
}

let state: Promise<SeasonalState> | undefined;

/** One fetch per build, shared by BaseLayout, AnnouncementBar and the homepage. */
export function getSeasonal(): Promise<SeasonalState> {
  return (state ??= load());
}

async function load(): Promise<SeasonalState> {
  let settings: any;
  try {
    settings = await sanityClient.fetch(siteSettingsQuery);
  } catch {
    return { campaign: null, announcementShown: false }; // never fail a build over seasonal data
  }
  const bar = settings?.announcementBar;
  const announcementShown = !!(bar?.enabled && bar?.text?.trim());

  const c = settings?.seasonalCampaign;
  const start = Date.parse(c?.startDate ?? '');
  const end = Date.parse(c?.endDate ?? '');
  const usable =
    c?.enabled === true &&
    end > start &&
    end > Date.now() &&
    !!c.heroImageDesktop?.url &&
    !!c.heroImageAlt?.trim();
  if (!usable) return { campaign: null, announcementShown };

  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    announcementShown,
    campaign: {
      label: text(c.label),
      startDate: new Date(start).toISOString(),
      endDate: new Date(end).toISOString(),
      heroImageDesktop: c.heroImageDesktop,
      heroImageMobile: c.heroImageMobile?.url ? c.heroImageMobile : undefined,
      heroImageAlt: c.heroImageAlt.trim(),
      eyebrow: text(c.eyebrow),
      headlineLine1: text(c.headlineLine1),
      headlineLine2: text(c.headlineLine2),
      body: text(c.body),
      snow: c.snow !== false,
      snowCap: c.snowCap !== false,
    },
  };
}
