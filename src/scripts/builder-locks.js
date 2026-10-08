/**
 * Which builder controls a mode does not offer at all (hidden, not disabled).
 *
 * Customise mode ("Customise this design") is the shop's artwork with the
 * customer's wording: only text, dates and colours are theirs. So it hides
 *   logo          the publisher-logo box (Replace logo / Use default / fill)
 *   sampleColours "Take colours from photo" -- there is no customer photo
 *   styleHint     "Not sure? Classic for portraits..." -- there is no style switch
 * Studio, the photo builders (customer) and admin keep all three.
 *
 * The publisher stamp is also enforced on the save path
 * (netlify/functions/_shared/customise-stamp.mjs); this only stops offering it.
 * Unit-tested in tests/builder-locks.test.mjs.
 */
export function hiddenControls(mode) {
  const customise = mode === 'customise';
  return { logo: customise, sampleColours: customise, styleHint: customise };
}
