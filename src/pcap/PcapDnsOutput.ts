type Fields = (name: string) => readonly string[];
interface Attribution {
  readonly incomplete: boolean;
  readonly assigned: readonly (readonly [string, string])[];
  readonly unattributed: readonly string[];
}

const dnsType = (value: string | undefined): number | null => {
  if (value === undefined || !/^(?:[0-9]+|0x[0-9a-f]+)$/iu.test(value))
    return null;
  const type = Number(value);
  return Number.isInteger(type) && type <= 65535 ? type : null;
};

// DNS compares ASCII letters without changing retained producer spellings.
const nameKey = (name: string): string =>
  name.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());

/**
 * TShark visits answer, authority, then additional RRs, emitting one
 * dns.resp.name/type per RR (including OPT), and type-specific value queues.
 * NSEC/NXT bitmaps may add type fields; the cardinality check declines those
 * ambiguous flat inventories instead of reconstructing missing hierarchy.
 * Validate that correspondence before joining any owner to an address.
 */
export const attributeDnsAddresses = (field: Fields): Attribution => {
  const ipv4 = field("dns.a");
  const ipv6 = field("dns.aaaa");
  const addresses = [...ipv4, ...ipv6].filter((value) => value !== "");
  const unknown = (): Attribution => ({
    assigned: [],
    unattributed: addresses,
    incomplete:
      addresses.length > 0 ||
      field("dns.flags.response").some(
        (value) => value !== "0" && value !== "False",
      ) ||
      field("dns.resp.name").length > 0 ||
      field("dns.resp.type").length > 0 ||
      ["dns.count.answers", "dns.count.auth_rr", "dns.count.add_rr"].some(
        (key) => field(key).some((value) => value !== "0"),
      ),
  });
  const count = (key: string): number | null => {
    const values = field(key);
    if (values.length !== 1 || !/^\d+$/u.test(values[0]!)) return null;
    const value = Number(values[0]);
    return Number.isInteger(value) && value <= 65535 ? value : null;
  };
  const response = field("dns.flags.response");
  const questions = field("dns.qry.name");
  const questionTypes = field("dns.qry.type");
  const answers = count("dns.count.answers");
  const authority = count("dns.count.auth_rr");
  const additional = count("dns.count.add_rr");
  if (answers === null || authority === null || additional === null)
    return unknown();
  const owners = field("dns.resp.name");
  const types = field("dns.resp.type").map(dnsType);
  const aliases = field("dns.cname");
  if (
    owners.length !== answers + authority + additional ||
    types.length !== owners.length ||
    types.some((value) => value === null) ||
    types.filter((type) => type === 1).length !== ipv4.length ||
    types.filter((type) => type === 28).length !== ipv6.length ||
    types.filter((type) => type === 5).length !== aliases.length ||
    [...ipv4, ...ipv6, ...aliases].some((value) => value === "")
  )
    return unknown();
  if (addresses.length === 0)
    return { assigned: [], unattributed: [], incomplete: false };
  if (
    response.length !== 1 ||
    !["1", "True"].includes(response[0]!) ||
    count("dns.count.queries") !== 1 ||
    questions.length !== 1 ||
    questions[0] === "" ||
    questionTypes.length !== 1 ||
    ![1, 28, 255].includes(dnsType(questionTypes[0]) ?? -1)
  )
    return unknown();
  let a = 0,
    aaaa = 0,
    cname = 0;
  const records = types.map((type, index) => ({
    owner: nameKey(owners[index]!),
    type,
    answer: index < answers,
    value:
      type === 1
        ? ipv4[a++]
        : type === 28
          ? ipv6[aaaa++]
          : type === 5
            ? aliases[cname++]
            : undefined,
  }));
  const reachable = new Set([nameKey(questions[0]!)]);
  const links = new Map<string, Set<string>>();
  for (const record of records)
    if (record.answer && record.type === 5) {
      if (record.owner === "") return unknown();
      const targets = links.get(record.owner) ?? new Set<string>();
      targets.add(nameKey(record.value!));
      links.set(record.owner, targets);
    }
  // A conflicting CNAME does not establish which target the question resolves.
  let current = nameKey(questions[0]!);
  while (links.has(current)) {
    const targets = links.get(current)!;
    if (targets.size !== 1) return unknown();
    const next = targets.values().next().value!;
    if (reachable.has(next)) return unknown();
    reachable.add(next);
    current = next;
  }
  const assigned: (readonly [string, string])[] = [];
  const unattributed: string[] = [];
  for (const record of records) {
    if (record.type !== 1 && record.type !== 28) continue;
    if (
      record.answer &&
      record.owner !== "" &&
      reachable.has(record.owner) &&
      (dnsType(questionTypes[0]) === 255 ||
        dnsType(questionTypes[0]) === record.type) &&
      !links.has(record.owner)
    )
      assigned.push([questions[0]!, record.value!]);
    else unattributed.push(record.value!);
  }
  return { assigned, unattributed, incomplete: unattributed.length > 0 };
};
