/**
 * Theme per product, for "You might also like" on product pages.
 *
 * Until Oct 2026 the related products were simply the next three in the same
 * category, so Kill Bill offered Braveheart, Breaking Bad and Bricktop
 * (alphabetical neighbours). Grouping by theme means a horror fan sees horror
 * and a football fan sees football.
 *
 * Keyed by product slug. A product missing from this map (a new one, say) still
 * gets sensible picks from its own category; add it here to give it a theme.
 * Personalised products are not listed: they never appear as related items.
 */
export type Theme =
  | 'horror' | 'crime-film' | 'action-scifi' | 'film-classic' | 'tv'
  | 'music-rock' | 'music-pop' | 'music-hiphop'
  | 'football' | 'combat-sport' | 'sport'
  | 'icon';

const T: Record<Theme, string[]> = {
  horror: [
    'michael-myers', 'jason-voorhees', 'freddy-krueger', 'ghostface', 'pennywise', 'chucky',
    'hannibal-lecter', 'the-shining', 'psycho', 'saw', 'cape-fear', 'patrick-bateman',
    'gremlins', 'gizmo', 'ghostbusters', 'shaun-of-the-dead', 'the-rocky-horror-show',
    'little-shop-of-horrors', 'stranger-things', 'ellen-ripley', 'blade',
  ],
  'crime-film': [
    'pulp-fiction', 'jules-winnfield', 'mia-wallace', 'marcellus-wallace', 'reservoir-dogs',
    'kill-bill', 'true-romance', 'clarence-worley', 'scarface-cover', 'scarface-icon', 'scarface-strip',
    'the-godfather', 'goodfellas', 'marlon-brando', 'snatch', 'lock-stock-and-two-smoking-barrels',
    'bricktop', 'bullet-tooth-tony', 'the-krays', 'the-usual-suspects', 'leon',
    'travis-bickle', 'travis-bickle-cover', 'travis-bickle-icon', 'gordon-gekko',
    'harry-callahan', 'the-french-connection', 'bullit', 'raging-bull', 'the-warriors',
    'the-warriors-icon', 'the-wanderers', 'fight-club', 'tyler-durden-cover', 'tyler-durden-icon',
    'a-clockwork-orange', 'trainspotting', 'inglorious-basterds', 'man-with-no-name',
    'butch-cassidy-and-the-sundance-kid', 'the-deer-hunter', 'platoon',
  ],
  'action-scifi': [
    'the-terminator', 'robocop', 'mad-max', 'mad-max-desert-rig', 'rambo', 'die-hard',
    'star-trek', 'darth-vader', 'han-solo', 'indiana-jones-icon', 'indiana-jones-cover',
    'rick-deckard', 'top-gun', 'gladiator', 'braveheart', 'superman', 'batmanandrobin',
    'deadpool-cover', 'deadpool-icon', 'kick-ass', 'hancock', 'the-mask', 'jack-sparrow',
    '007-daniel-craig', '007-sean-connery', 'back-to-the-future', 'marty-mcfly-icon',
    'marty-mcfly-cover', 'e-t', 'rocky-cover', 'rocky-icon', 'bruce-lee', 'bruce-lee-cover',
    'the-great-escape',
  ],
  'film-classic': [
    'the-breakfast-club', 'ferris-bueller', 'jeff-spicoli', 'stand-by-me', 'big', 'dirty-dancing',
    'grease', 'grease-icon', 'fame', 'pretty-woman', 'ghost', 'forrest-gump', 'the-graduate',
    'casablanca', 'breakfast-at-tiffany-s', 'an-officer-and-a-gentleman', 'animal-house',
    'the-blues-brothers', 'the-big-lebowski', 'waynes-world', 'jay-and-silent-bob',
    'good-morning-vietnam', 'one-flew-over-the-cuckoos-nest', 'the-wizard-of-oz', 'willy-wonka',
    'the-greatest-showman', 'harry-and-marv', 'hot-fuzz', 'paul', 'quadrophenia',
  ],
  tv: [
    'breaking-bad', 'walter-white', 'walter-white-icon', 'peaky-blinders', 'only-fools-and-horses',
    'del-boy', 'the-inbetweeners', 'fresh-prince-of-bel-air', 'the-a-team', 'mr-t', 'kojak',
    'andy-kaufman', 'the-monkees',
  ],
  'music-rock': [
    'oasis', 'oasis-knebworth', 'liam-gallagher', 'noel-gallagher', 'the-stone-roses',
    'happy-mondays', 'the-arctic-monkeys', 'pete-doherty', 'the-jam', 'paul-weller', 'the-smiths',
    'the-cure', 'the-beatles', 'john-lennon', 'the-rolling-stones', 'pink-floyd', 'u2', 'rem',
    'michael-stipe', 'nirvana', 'kurt-cobain-icon', 'kurt-cobain-cover', 'green-day',
    'the-sex-pistols', 'sid-vicious', 'john-lydon', 'joey-ramone', 'iggy-pop', 'blondie',
    'debbie-harry', 'adam-and-the-ants', 'keith-flint', 'iron-maiden', 'ozzy-osbourne', 'lemmy',
    'slash', 'steven-tyler', 'flea', 'zz-top', 'mark-knopfler', 'jimi-hendrix-cover',
    'jimi-hendrix-icon', 'jim-morrison', 'bob-dylan', 'bob-marley', 'bob-marley-cover',
    'bob-marley-icon', 'david-bowie', 'freddie-mercury', 'queen-live-aid', 'queen-wembley-86',
    'elvis', 'elvis-presley',
  ],
  'music-pop': [
    'madonna-icon', 'madonna-cover', 'michael-jackson', 'prince', 'george-michael', 'wham',
    'kylie', 'boy-george', 'elton-john', 'robbie-williams', 'britney-spears', 'justin-timberlake',
    'beyonce', 'ariana-grande', 'billie-eilish-strip', 'billie-eilish-icon', 'ed-sheeran',
    'ed-sheeran-icon', 'lewis-capaldi', 'justin-bieber', 'bruno-mars', 'pink', 'the-weeknd',
    'stevie-wonder', 'frank-sinatra', 'the-rat-pack',
  ],
  'music-hiphop': [
    'tupac', 'notorious-big', 'eazy-e', 'ice-cube', 'ice-t', 'snoop-dogg', 'run-dmc', 'eminem',
    'juice-wrld', 'pop-smoke', 'post-malone', '6ix9ine',
  ],
  football: [
    'england-world-cup-1966', 'england-1966-kissing-the-trophy', 'england-euro-96', 'gazza',
    'hand-of-god', 'diego-maradona', 'beckham-vs-greece', 'david-beckham', 'messi-world-cup-2022',
    'leo-messi-cover', 'leo-messi-icon', 'anfield-89', 'liverpool-champions-league-2005',
    'man-utd-1998-99', 'the-invincibles', 'leicester-city-fc', 'west-ham-legends', 'eric-cantona',
    'george-best', 'pele-icon', 'pele-cover', 'bobby-moore', 'bobby-moore-and-pele', 'thierry-henry',
    'mo-salah', 'kevin-keegan', 'stuart-pearce', 'jimmy-greaves', 'gerrard-and-lampard',
    'john-terry', 'sergio-aguero', 'jurgen-klopp', 'rooney-and-ronaldo',
  ],
  'combat-sport': [
    'muhammad-ali', 'muhammad-ali-icon', 'ali-vs-liston', 'hagler-vs-hearns', 'marvin-hagler',
    'tyson-vs-holyfield', 'mike-tyson', 'anthony-joshua', 'lennox-lewis', 'prince-naseem-hamed',
    'conor-mcgregor',
  ],
  sport: [
    'ayrton-senna-icon', 'ayrton-senna-cover', 'james-hunt', 'valentino-rossi', 'federer-vs-nadal',
    'roger-federer-cover', 'roger-federer-icon', 'rafael-nadal-icon', 'rafael-nadal-cover',
    'john-mcenroe', 'bjorn-borg', 'andre-agassi', 'rugby-world-cup-final-2003', 'jonny-wilkinson',
    'usain-bolt-icon', 'usain-bolt-cover', 'mo-farah', 'michael-jordan', 'kobe-bryant',
    'kobe-bryant-jersey-to-mouth', 'lebron-james-cover', 'lebron-james-icon', 'tom-brady',
    'tiger-woods-cover', 'tiger-woods-icon',
  ],
  icon: [
    'albert-einstein', 'che-guevara-cover', 'che-guevara-icon', 'audrey-hepburn', 'marilyn-monroe',
    'james-dean', 'steve-mcqueen', 'michael-caine',
  ],
};

/** Themes that sit next to each other, used to top up a short list. */
export const NEAR: Record<Theme, Theme[]> = {
  horror: ['action-scifi', 'crime-film'],
  'crime-film': ['film-classic', 'action-scifi', 'tv'],
  'action-scifi': ['crime-film', 'film-classic'],
  'film-classic': ['crime-film', 'action-scifi', 'tv'],
  tv: ['crime-film', 'film-classic'],
  'music-rock': ['music-pop', 'music-hiphop'],
  'music-pop': ['music-rock', 'music-hiphop'],
  'music-hiphop': ['music-pop', 'music-rock'],
  football: ['sport', 'combat-sport'],
  'combat-sport': ['sport', 'football'],
  sport: ['football', 'combat-sport'],
  icon: ['film-classic', 'music-pop'],
};

export const THEME_BY_SLUG: Record<string, Theme> = Object.fromEntries(
  (Object.entries(T) as [Theme, string[]][]).flatMap(([theme, slugs]) => slugs.map((s) => [s, theme]))
);
