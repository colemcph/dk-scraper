/**
 * Canonical NFL team registry, for matching the same game across sportsbooks.
 *
 * Books name teams differently — DraftKings "DET Lions" / "LA Chargers" / "NY Jets", FanDuel
 * "Detroit Lions" / "Los Angeles Chargers" / "New York Jets" — but every NFL nickname is unique,
 * so the last word of a name is enough once the obvious aliases and abbreviations are covered.
 * The registry is NFL-only on purpose: another league needs its own table (MLB "Giants" vs NFL
 * "Giants" is exactly the kind of clash a shared one would create).
 */
export interface TeamInfo {
  /** Canonical id, the common abbreviation. */
  id: string;
  city: string;
  nickname: string;
  /** Primary brand colour, for a consistent swatch across books. */
  color: string;
  aliases?: string[];
}

export const NFL_TEAMS: readonly TeamInfo[] = [
  { id: 'ARI', city: 'Arizona', nickname: 'Cardinals', color: '#97233F', aliases: ['ARZ'] },
  { id: 'ATL', city: 'Atlanta', nickname: 'Falcons', color: '#A71930' },
  { id: 'BAL', city: 'Baltimore', nickname: 'Ravens', color: '#241773' },
  { id: 'BUF', city: 'Buffalo', nickname: 'Bills', color: '#00338D' },
  { id: 'CAR', city: 'Carolina', nickname: 'Panthers', color: '#0085CA' },
  { id: 'CHI', city: 'Chicago', nickname: 'Bears', color: '#0B162A' },
  { id: 'CIN', city: 'Cincinnati', nickname: 'Bengals', color: '#FB4F14' },
  { id: 'CLE', city: 'Cleveland', nickname: 'Browns', color: '#311D00' },
  { id: 'DAL', city: 'Dallas', nickname: 'Cowboys', color: '#003594' },
  { id: 'DEN', city: 'Denver', nickname: 'Broncos', color: '#FB4F14' },
  { id: 'DET', city: 'Detroit', nickname: 'Lions', color: '#0076B6' },
  { id: 'GB', city: 'Green Bay', nickname: 'Packers', color: '#203731' },
  { id: 'HOU', city: 'Houston', nickname: 'Texans', color: '#03202F' },
  { id: 'IND', city: 'Indianapolis', nickname: 'Colts', color: '#002C5F' },
  { id: 'JAX', city: 'Jacksonville', nickname: 'Jaguars', color: '#006778', aliases: ['JAC'] },
  { id: 'KC', city: 'Kansas City', nickname: 'Chiefs', color: '#E31837' },
  {
    id: 'LV',
    city: 'Las Vegas',
    nickname: 'Raiders',
    color: '#000000',
    aliases: ['LVR', 'Oakland Raiders'],
  },
  {
    id: 'LAC',
    city: 'Los Angeles',
    nickname: 'Chargers',
    color: '#0080C6',
    aliases: ['LA Chargers', 'San Diego Chargers'],
  },
  {
    id: 'LAR',
    city: 'Los Angeles',
    nickname: 'Rams',
    color: '#003594',
    aliases: ['LA Rams', 'St. Louis Rams'],
  },
  { id: 'MIA', city: 'Miami', nickname: 'Dolphins', color: '#008E97' },
  { id: 'MIN', city: 'Minnesota', nickname: 'Vikings', color: '#4F2683' },
  { id: 'NE', city: 'New England', nickname: 'Patriots', color: '#002244', aliases: ['NEP'] },
  { id: 'NO', city: 'New Orleans', nickname: 'Saints', color: '#D3BC8D', aliases: ['NOS'] },
  { id: 'NYG', city: 'New York', nickname: 'Giants', color: '#0B2265', aliases: ['NY Giants'] },
  { id: 'NYJ', city: 'New York', nickname: 'Jets', color: '#125740', aliases: ['NY Jets'] },
  { id: 'PHI', city: 'Philadelphia', nickname: 'Eagles', color: '#004C54' },
  { id: 'PIT', city: 'Pittsburgh', nickname: 'Steelers', color: '#FFB612' },
  {
    id: 'SF',
    city: 'San Francisco',
    nickname: '49ers',
    color: '#AA0000',
    aliases: ['SFO', 'Niners'],
  },
  { id: 'SEA', city: 'Seattle', nickname: 'Seahawks', color: '#002244' },
  {
    id: 'TB',
    city: 'Tampa Bay',
    nickname: 'Buccaneers',
    color: '#D50A0D',
    aliases: ['TBB', 'Bucs'],
  },
  { id: 'TEN', city: 'Tennessee', nickname: 'Titans', color: '#0C2340' },
  {
    id: 'WAS',
    city: 'Washington',
    nickname: 'Commanders',
    color: '#5A1414',
    aliases: ['WSH', 'Washington', 'Washington Football Team', 'Washington Redskins'],
  },
];

/** Lower-case, punctuation stripped, single-spaced: "L.A. Rams" -> "l a rams". */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const INDEX: Map<string, TeamInfo> = (() => {
  const index = new Map<string, TeamInfo>();
  for (const t of NFL_TEAMS) {
    const keys = [
      t.id,
      t.nickname,
      `${t.city} ${t.nickname}`,
      `${t.id} ${t.nickname}`,
      ...(t.aliases ?? []),
    ];
    for (const k of keys) index.set(normalizeName(k), t);
  }
  return index;
})();

/**
 * Resolve any of the spellings a sportsbook uses to the canonical team, or undefined when the
 * name is not an NFL team (never guess: a wrong match would pair two different games).
 */
export function canonicalTeam(name: string): TeamInfo | undefined {
  const n = normalizeName(name);
  if (!n) return undefined;
  const direct = INDEX.get(n);
  if (direct) return direct;
  // "det lions", "los angeles chargers", "washington football team": the nickname is the tail.
  const tokens = n.split(' ');
  for (let i = 1; i < tokens.length; i++) {
    const hit = INDEX.get(tokens.slice(i).join(' '));
    if (hit) return hit;
  }
  return undefined;
}
