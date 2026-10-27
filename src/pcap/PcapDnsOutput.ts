type Fields = (name: string) => readonly string[];
interface DnsPacketFacts {
  readonly questions: readonly string[];
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
 * dns.resp.type per RR (including OPT), and type-specific value queues.
 * SRV owners use dns.srv.* fields instead of dns.resp.name, so the owner
 * queue advances only for other RR types.
 * NSEC/NXT bitmaps may add type fields; the cardinality check declines those
 * ambiguous flat inventories instead of reconstructing missing hierarchy.
 * Validate that correspondence before joining any owner to an address.
 */
export const parseDnsPacketFields = (field: Fields): DnsPacketFacts => {
  const questions = field("dns.qry.name");
  const retainedQuestions = [
    ...new Set(questions.filter((value) => value !== "")),
  ];
  const ipv4 = field("dns.a");
  const ipv6 = field("dns.aaaa");
  const addresses = [...ipv4, ...ipv6].filter((value) => value !== "");
  const unknown = (): DnsPacketFacts => ({
    questions: retainedQuestions,
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
  const questionTypes = field("dns.qry.type");
  const questionType =
    questionTypes.length === 1 ? dnsType(questionTypes[0]) : null;
  const answers = count("dns.count.answers");
  const authority = count("dns.count.auth_rr");
  const additional = count("dns.count.add_rr");
  if (answers === null || authority === null || additional === null)
    return unknown();
  const owners = field("dns.resp.name");
  const types = field("dns.resp.type").map(dnsType);
  const aliases = field("dns.cname");
  // OPT stores a UDP payload size instead of dns.resp.class. mDNS uses
  // these same class fields with QU/cache-flush bits masked by the producer.
  const classes = field("dns.resp.class").map(dnsType);
  if (
    types.length !== answers + authority + additional ||
    owners.length !== types.filter((type) => type !== 33).length ||
    types.some((value) => value === null) ||
    types.filter((type) => type === 1).length !== ipv4.length ||
    types.filter((type) => type === 28).length !== ipv6.length ||
    types.filter((type) => type === 5).length !== aliases.length ||
    [...ipv4, ...ipv6, ...aliases].some((value) => value === "")
  )
    return unknown();
  if (addresses.length === 0)
    return {
      questions: retainedQuestions,
      assigned: [],
      unattributed: [],
      incomplete: false,
    };
  // Only IN establishes Internet address semantics. An ANY-class question
  // also permits IN answers; other classes retain the producer values without
  // interpreting their class-specific RDATA as a resolved Internet address.
  const questionClasses = field("dns.qry.class");
  if (
    classes.length !== types.filter((type) => type !== 41).length ||
    classes.some((value) => value === null) ||
    questionClasses.length !== 1 ||
    ![1, 255].includes(dnsType(questionClasses[0]) ?? -1) ||
    response.length !== 1 ||
    !["1", "True"].includes(response[0]!) ||
    count("dns.count.queries") !== 1 ||
    questions.length !== 1 ||
    questions[0] === "" ||
    questionTypes.length !== 1 ||
    ![1, 28, 255].includes(questionType ?? -1)
  )
    return unknown();
  let a = 0,
    aaaa = 0,
    cname = 0,
    owner = 0,
    rrClass = 0;
  const records = types.map((type, index) => ({
    owner: type === 33 ? "" : nameKey(owners[owner++]!),
    type,
    dnsClass: type === 41 ? null : classes[rrClass++],
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
    if (record.answer && record.type === 5 && record.dnsClass === 1) {
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
      record.dnsClass === 1 &&
      record.owner !== "" &&
      reachable.has(record.owner) &&
      (questionType === 255 || questionType === record.type) &&
      !links.has(record.owner)
    )
      assigned.push([questions[0]!, record.value!]);
    else unattributed.push(record.value!);
  }
  return {
    questions: retainedQuestions,
    assigned,
    unattributed,
    incomplete: unattributed.length > 0,
  };
};
