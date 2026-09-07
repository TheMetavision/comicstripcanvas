# Comic Strip Canvas -- agent handoff

---

## Path migration (May 2026)

Generated 2026-05-02 during the Downloads -> Projects migration.

### Path change

- **Old path:** `C:\Users\chris\Downloads\Comic Strip Canvas Astro Site\csc`
- **New path:** `C:\Users\chris\Projects\comicstripcanvas`

Any older agent instructions, scripts, or notes that reference the old path should be treated as referring to the new path.

### Quick stack reference

- **Brand:** Comic Strip Canvas
- **Sanity project ID:** `lwbwahym`
- **GitHub remote:** https://github.com/TheMetavision/comicstripcanvas.git
- **Stack:** Astro + Sanity CMS + Netlify (per Metavision house standard)

### Notes

Pending: Resend DNS verify, domain DNS to Netlify, Sanity build hook, live Stripe keys.

Resolved 2026-09-07: the "personalise function 500 error" was verified fixed and
removed from the list above. `/api/personalise` returns 200 in production and for
all 27 valid style x format x size inputs locally. The inline `config.path` that
caused the original routing failure was removed in commit f1ada47; no function
under `netlify/functions/` sets it, and that fault mode produced a 404, not a 500.

