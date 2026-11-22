export interface ScoredLink {
  a: string;
  b: string;
  score: number;
}

export interface Clustering {
  /** cluster id -> sorted members; only clusters of two or more */
  clusters: Map<string, string[]>;
  /** links that were applied, strongest first */
  applied: ScoredLink[];
  /** links refused because the merged cluster would exceed the cap */
  refused: ScoredLink[];
}

/** Stable id: the cluster is named after its smallest member (A10023 -> C10023). */
export function clusterId(members: string[]): string {
  const min = members.reduce((m, x) => (x < m ? x : m));
  return `C${min.slice(1)}`;
}

/**
 * Union-find over links, strongest first. A merge that would push a cluster
 * past `maxSize` is refused and handed to an analyst, which is what stops one
 * shared public computer from chaining strangers into one giant cluster.
 */
export function clusterLinks(links: ScoredLink[], maxSize: number): Clustering {
  const parent = new Map<string, string>();
  const size = new Map<string, number>();
  const find = (x: string): string => {
    if (!parent.has(x)) {
      parent.set(x, x);
      size.set(x, 1);
    }
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const sorted = [...links].sort((x, y) => y.score - x.score || (x.a + x.b < y.a + y.b ? -1 : 1));
  const applied: ScoredLink[] = [];
  const refused: ScoredLink[] = [];
  for (const l of sorted) {
    const ra = find(l.a);
    const rb = find(l.b);
    if (ra === rb) {
      applied.push(l);
      continue;
    }
    if (size.get(ra)! + size.get(rb)! > maxSize) {
      refused.push(l);
      continue;
    }
    const [big, small] = size.get(ra)! >= size.get(rb)! ? [ra, rb] : [rb, ra];
    parent.set(small, big);
    size.set(big, size.get(big)! + size.get(small)!);
    applied.push(l);
  }
  const groups = new Map<string, string[]>();
  for (const x of parent.keys()) {
    const r = find(x);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(x);
  }
  const clusters = new Map<string, string[]>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort();
    clusters.set(clusterId(members), members);
  }
  return { clusters, applied, refused };
}
