import { expect, it } from "vitest";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { parseCapinfosOutput, parseTsharkJsonOutput } from "./PcapOutput.js";

const capture = (layers: ReadonlyArray<Record<string, string[]>>) =>
  JSON.stringify(
    layers.map((fields, index) => ({
      _source: {
        layers: {
          "frame.number": [String(index + 1)],
          "frame.protocols": ["ip:udp:dns"],
          ...fields,
        },
      },
    })),
  );

// Representative selected-field output for one A reply with a CNAME answer
// and unrelated additional glue. This is not a recorded real-provider run.
const cnameAndGlue = {
  "dns.flags.response": ["1"],
  "dns.qry.name": ["www.example"],
  "dns.qry.type": ["1"],
  "dns.count.queries": ["1"],
  "dns.count.answers": ["2"],
  "dns.count.auth_rr": ["0"],
  "dns.count.add_rr": ["1"],
  "dns.resp.name": ["www.example", "edge.example", "ns.example"],
  "dns.resp.type": ["5", "1", "1"],
  "dns.cname": ["edge.example"],
  "dns.a": ["192.0.2.10", "192.0.2.53"],
};

// Source-backed selected-field shape: Wireshark 4.x add_rr_to_tree emits
// dns.srv.* instead of dns.resp.name for SRV owners. Not a provider recording.
// https://github.com/wireshark/wireshark/blob/v4.4.10/epan/dissectors/packet-dns.c#L1926-L1976
const srvAndAddresses = {
  "dns.flags.response": ["1"],
  "dns.qry.name": ["WWW.Example"],
  "dns.qry.type": ["255"],
  "dns.count.queries": ["1"],
  "dns.count.answers": ["4"],
  "dns.count.auth_rr": ["0"],
  "dns.count.add_rr": ["1"],
  "dns.resp.type": ["33", "1", "33", "28", "1"],
  "dns.resp.name": ["www.example", "www.example", "ns.example"],
  "dns.a": ["192.0.2.10", "192.0.2.53"],
  "dns.aaaa": ["2001:db8::10"],
};

it("keeps address-free SRV answers complete without requiring dns.resp.name", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      {
        ...srvAndAddresses,
        "dns.qry.name": ["_sip._tcp.example"],
        "dns.qry.type": ["33"],
        "dns.count.answers": ["1"],
        "dns.count.add_rr": ["0"],
        "dns.resp.type": ["33"],
        "dns.resp.name": [],
        "dns.a": [],
        "dns.aaaa": [],
      },
    ]),
  );
  expect(result.partial).toBe(false);
  expect(result.dnsQueries[0]?.response_addresses).toEqual([]);
});

it("aligns A and AAAA owners around SRV records while retaining additional glue separately", async () => {
  const result = await parseTsharkJsonOutput(capture([srvAndAddresses]));
  expect(result.dnsQueries).toEqual([
    {
      query: "WWW.Example",
      response_addresses: ["192.0.2.10", "2001:db8::10"],
      response_address_count: 2,
    },
  ]);
  expect(result.unattributedDnsAddresses).toEqual(["192.0.2.53"]);
  expect(result.partial).toBe(true);
});

it.each([
  { "dns.resp.name": ["www.example", "ns.example"] },
  {
    "dns.resp.name": [
      "srv.example",
      "www.example",
      "www.example",
      "ns.example",
    ],
  },
  { "dns.resp.type": ["33", "1", "33", "28"] },
  { "dns.count.answers": ["4", "0"] },
  { "dns.flags.response": ["1", "1"] },
])("declines ambiguous SRV owner inventories: %j", async (override) => {
  const result = await parseTsharkJsonOutput(
    capture([{ ...srvAndAddresses, ...override }]),
  );
  expect(result.dnsQueries[0]?.response_addresses).toEqual([]);
  expect(result.unattributedDnsAddresses).toEqual([
    "192.0.2.10",
    "192.0.2.53",
    "2001:db8::10",
  ]);
  expect(result.partial).toBe(true);
});

it("reports unknown RR coverage when a DNS response omits all count and address fields", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      {
        "dns.flags.response": ["1"],
        "dns.qry.name": ["www.example"],
      },
    ]),
  );
  expect(result.dnsQueries[0]?.response_addresses).toEqual([]);
  expect(result.unattributedDnsAddresses).toEqual([]);
  expect(result.partial).toBe(true);
});

it("keeps a query with an additional OPT record complete", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      {
        ...cnameAndGlue,
        "dns.flags.response": ["0"],
        "dns.count.answers": ["0"],
        "dns.resp.name": [""],
        "dns.resp.type": ["41"],
        "dns.cname": [],
        "dns.a": [],
      },
    ]),
  );
  expect(result.partial).toBe(false);
});

it("preserves a CNAME answer while separating additional glue", async () => {
  const result = await parseTsharkJsonOutput(capture([cnameAndGlue]));
  expect(result.dnsQueries).toEqual([
    {
      query: "www.example",
      response_addresses: ["192.0.2.10"],
      response_address_count: 1,
    },
  ]);
  expect(result.unattributedDnsAddresses).toEqual(["192.0.2.53"]);
  expect(result.unattributedDnsPackets).toBe(1);
  expect(result.partial).toBe(true);
});

it("accepts hexadecimal RR type codes without changing recorded identities", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      {
        ...cnameAndGlue,
        "dns.qry.type": ["0x0001"],
        "dns.resp.type": ["0x0005", "0x0001", "0x0001"],
      },
    ]),
  );
  expect(result.dnsQueries[0]?.response_addresses).toEqual(["192.0.2.10"]);
  expect(result.unattributedDnsAddresses).toEqual(["192.0.2.53"]);
});

it("retains direct answers with a root-owned OPT and compares DNS names without rewriting them", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      {
        ...cnameAndGlue,
        "dns.qry.name": ["WWW.Example"],
        "dns.count.answers": ["1"],
        "dns.resp.name": ["www.example", ""],
        "dns.resp.type": ["1", "41"],
        "dns.cname": [],
        "dns.a": ["192.0.2.10"],
      },
    ]),
  );
  expect(result.dnsQueries).toEqual([
    {
      query: "WWW.Example",
      response_addresses: ["192.0.2.10"],
      response_address_count: 1,
    },
  ]);
  expect(result.partial).toBe(false);
});

it("joins mixed answer types using their own queues and preserves multiple valid answers", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      {
        ...cnameAndGlue,
        "dns.qry.type": ["255"],
        "dns.count.answers": ["5"],
        "dns.count.add_rr": ["0"],
        "dns.resp.name": [
          "www.example",
          "edge.example",
          "edge.example",
          "edge.example",
          "edge.example",
        ],
        "dns.resp.type": ["5", "28", "1", "28", "1"],
        "dns.a": ["192.0.2.10", "192.0.2.11"],
        "dns.aaaa": ["2001:db8::10", "2001:db8::11"],
      },
    ]),
  );
  expect(result.dnsQueries[0]?.response_addresses).toEqual([
    "2001:db8::10",
    "192.0.2.10",
    "2001:db8::11",
    "192.0.2.11",
  ]);
  expect(result.partial).toBe(false);
});

it.each([
  { "dns.resp.name": ["www.example", "unrelated.example", "ns.example"] },
  { "dns.count.answers": ["1"], "dns.count.auth_rr": ["1"] },
  { "dns.qry.type": ["28"] },
  { "dns.flags.response": ["1", "1"] },
  { "dns.count.answers": ["garbage"] },
  { "dns.count.answers": ["4"] },
  { "dns.count.answers": [] },
  { "dns.resp.name": ["www.example"] },
  { "dns.resp.type": ["5", "28", "1"] },
  { "dns.cname": [] },
  { "dns.cname": ["www.example"] },
  { "dns.count.queries": ["2"] },
  // NSEC/NXT type bitmaps can contribute additional dns.resp.type fields.
  { "dns.resp.type": ["5", "1", "47", "1", "28"] },
] as Record<string, string[]>[])(
  "retains all addresses when ownership is unsupported or inconsistent: %j",
  async (override) => {
    const result = await parseTsharkJsonOutput(
      capture([{ ...cnameAndGlue, ...override }]),
    );
    expect(result.dnsQueries[0]?.response_addresses).toEqual([]);
    expect(result.unattributedDnsAddresses).toEqual([
      "192.0.2.10",
      "192.0.2.53",
    ]);
    expect(result.partial).toBe(true);
  },
);

it("does not follow conflicting CNAME declarations", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      {
        ...cnameAndGlue,
        "dns.count.answers": ["4"],
        "dns.count.add_rr": ["0"],
        "dns.resp.name": [
          "www.example",
          "www.example",
          "edge.example",
          "other.example",
        ],
        "dns.resp.type": ["5", "5", "1", "1"],
        "dns.cname": ["edge.example", "other.example"],
      },
    ]),
  );
  expect(result.dnsQueries[0]?.response_addresses).toEqual([]);
  expect(result.unattributedDnsAddresses).toEqual(["192.0.2.10", "192.0.2.53"]);
});

it.each([
  { "dns.a": [] },
  { "dns.a": [], "dns.resp.name": [], "dns.resp.type": [] },
])(
  "marks missing address/owner decoding partial even when no addresses were extracted: %j",
  async (override) => {
    const result = await parseTsharkJsonOutput(
      capture([{ ...cnameAndGlue, ...override }]),
    );
    expect(result.dnsQueries[0]?.response_addresses).toEqual([]);
    expect(result.unattributedDnsAddresses).toEqual([]);
    expect(result.partial).toBe(true);
  },
);

it.each([
  { "dns.count.answers": ["0"], "dns.resp.name": [], "dns.resp.type": [] },
  {
    "dns.count.answers": ["1"],
    "dns.resp.name": ["www.example"],
    "dns.resp.type": ["2"],
  },
])(
  "keeps valid empty or non-address answers complete: %j",
  async (override) => {
    const result = await parseTsharkJsonOutput(
      capture([
        {
          ...cnameAndGlue,
          "dns.count.add_rr": ["0"],
          "dns.cname": [],
          "dns.a": [],
          ...override,
        },
      ]),
    );
    expect(result.dnsQueries[0]?.response_addresses).toEqual([]);
    expect(result.partial).toBe(false);
  },
);

it.each([
  [[], []],
  [["", ""], []],
  [["user_dlt:data", ""], [{ protocol: "user_dlt:data", packet_count: 1 }]],
  [["", "user_dlt:data"], [{ protocol: "user_dlt:data", packet_count: 1 }]],
  [
    ["user_dlt:data", "", "user_dlt:data"],
    [{ protocol: "user_dlt:data", packet_count: 2 }],
  ],
] as const)(
  "counts every frame while aggregating only reported protocol stacks: %j",
  async (stacks, expected) => {
    const result = await parseTsharkJsonOutput(
      capture(stacks.map((stack) => ({ "frame.protocols": [stack] }))),
    );
    expect(result.packetCount).toBe(stacks.length);
    expect(result.protocolDistribution).toEqual(expected);
    expect(result.protocolCount).toBe(expected.length);
    expect(result.partial).toBe(false);
  },
);

it.each([
  { "frame.number": ["1"] },
  { "frame.number": ["1"], "frame.protocols": [] },
  { "frame.number": ["1"], "frame.protocols": ["", "ip"] },
  { "frame.number": ["1"], "frame.protocols": ["ip", "ip"] },
  { "frame.number": ["1"], "frame.protocols": [null] },
  { "frame.number": ["1"], "frame.protocols": "" },
  { "frame.protocols": [""] },
  { "frame.number": ["2"], "frame.protocols": [""] },
])("rejects malformed or ambiguous frame inventories: %j", async (layers) => {
  await expect(
    parseTsharkJsonOutput(JSON.stringify([{ _source: { layers } }])),
  ).rejects.toMatchObject({ _tag: "AnalysisProtocolError" });
});

it.each(["before", "after"] as const)(
  "retains endpoint and DNS facts with an empty stack %s the response",
  async (position) => {
    const empty = { "frame.protocols": [""] };
    const response = {
      "frame.protocols": ["eth:ethertype:ip:udp:dns"],
      "ip.src": ["192.0.2.53"],
      "ip.dst": ["192.0.2.1"],
      "dns.qry.name": ["api.example"],
      "dns.flags.response": ["True"],
      "dns.a": ["203.0.113.5"],
      "dns.qry.type": ["1"],
      "dns.count.queries": ["1"],
      "dns.count.answers": ["1"],
      "dns.count.auth_rr": ["0"],
      "dns.count.add_rr": ["0"],
      "dns.resp.name": ["api.example"],
      "dns.resp.type": ["1"],
    };
    const result = await parseTsharkJsonOutput(
      capture(position === "before" ? [empty, response] : [response, empty]),
    );
    expect(result).toMatchObject({
      packetCount: 2,
      protocolCount: 1,
      protocolDistribution: [
        { protocol: "eth:ethertype:ip:udp:dns", packet_count: 1 },
      ],
      endpointCount: 2,
      endpoints: [
        { address: "192.0.2.1", port: null, packet_count: 1 },
        { address: "192.0.2.53", port: null, packet_count: 1 },
      ],
      dnsQueryCount: 1,
      dnsQueries: [
        {
          query: "api.example",
          response_addresses: ["203.0.113.5"],
          response_address_count: 1,
        },
      ],
      partial: false,
    });
  },
);

it("rejects duplicate frame identities even when protocol stacks are empty", async () => {
  await expect(
    parseTsharkJsonOutput(
      capture([
        { "frame.protocols": [""] },
        { "frame.number": ["1"], "frame.protocols": [""] },
      ]),
    ),
  ).rejects.toMatchObject({ _tag: "AnalysisProtocolError" });
});

it("binds interleaved DNS answers to the question in their response packet", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      { "dns.qry.name": ["alpha.example"], "dns.flags.response": ["False"] },
      { "dns.qry.name": ["beta.example"], "dns.flags.response": ["False"] },
      {
        "dns.qry.name": ["alpha.example"],
        "dns.flags.response": ["True"],
        "dns.a": ["192.0.2.10"],
        "dns.qry.type": ["1"],
        "dns.count.queries": ["1"],
        "dns.count.answers": ["1"],
        "dns.count.auth_rr": ["0"],
        "dns.count.add_rr": ["0"],
        "dns.resp.name": ["alpha.example"],
        "dns.resp.type": ["1"],
      },
      {
        "dns.qry.name": ["beta.example"],
        "dns.flags.response": ["True"],
        "dns.a": ["192.0.2.20"],
        "dns.qry.type": ["1"],
        "dns.count.queries": ["1"],
        "dns.count.answers": ["1"],
        "dns.count.auth_rr": ["0"],
        "dns.count.add_rr": ["0"],
        "dns.resp.name": ["beta.example"],
        "dns.resp.type": ["1"],
      },
    ]),
  );
  expect(result.dnsQueries).toEqual([
    {
      query: "alpha.example",
      response_addresses: ["192.0.2.10"],
      response_address_count: 1,
    },
    {
      query: "beta.example",
      response_addresses: ["192.0.2.20"],
      response_address_count: 1,
    },
  ]);
  expect(result.partial).toBe(false);
});

it("retains unassignable DNS addresses without inventing a query relationship", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      {
        "dns.qry.name": ["alpha.example", "beta.example"],
        "dns.flags.response": ["True"],
        "dns.a": ["192.0.2.9"],
      },
      { "dns.flags.response": ["True"], "dns.aaaa": ["2001:db8::9"] },
    ]),
  );
  expect(
    result.dnsQueries.every((query) => query.response_addresses.length === 0),
  ).toBe(true);
  expect(result.unattributedDnsAddresses).toEqual(["192.0.2.9", "2001:db8::9"]);
  expect(result.unattributedDnsPackets).toBe(2);
  expect(result.partial).toBe(true);
});

it("counts IPv6 endpoints once per packet and preserves every examined fact", async () => {
  const packets = Array.from({ length: 51 }, (_, index) => ({
    "ipv6.src": ["2001:db8::1"],
    "ipv6.dst": ["2001:db8::1"],
    "tls.handshake.extensions_server_name": [`host${String(index)}.example`],
    "frame.protocols": [`ipv6:protocol${String(index)}`],
  }));
  const result = await parseTsharkJsonOutput(capture(packets));
  expect(result.endpoints).toEqual([
    { address: "2001:db8::1", port: null, packet_count: 51 },
  ]);
  expect(result.tlsSniCount).toBe(51);
  expect(result.tlsSniValues).toHaveLength(51);
  expect(result.protocolCount).toBe(51);
  expect(result.protocolDistribution).toHaveLength(51);
  expect(result.partial).toBe(false);
});

it("orders equal-count endpoints and protocols by code point, not host locale", async () => {
  // Locale collation puts "fe80::1" first and, under da-DK, "aarp" after "zz".
  const result = await parseTsharkJsonOutput(
    capture([
      { "ipv6.src": ["fe80::1"], "frame.protocols": ["eth:llc:zz"] },
      { "ipv6.src": ["fe80:1::1"], "frame.protocols": ["eth:llc:aarp"] },
    ]),
  );
  expect(result.endpoints.map(({ address }) => address)).toEqual([
    "fe80:1::1",
    "fe80::1",
  ]);
  expect(result.protocolDistribution.map(({ protocol }) => protocol)).toEqual([
    "eth:llc:aarp",
    "eth:llc:zz",
  ]);
});

it("preserves all DNS addresses and their exact examined count", async () => {
  const result = await parseTsharkJsonOutput(
    capture(
      Array.from({ length: 101 }, (_, index) => ({
        "dns.qry.name": ["rotating.example"],
        "dns.flags.response": ["True"],
        "dns.a": [`192.0.2.${String(index)}`],
        "dns.qry.type": ["1"],
        "dns.count.queries": ["1"],
        "dns.count.answers": ["1"],
        "dns.count.auth_rr": ["0"],
        "dns.count.add_rr": ["0"],
        "dns.resp.name": ["rotating.example"],
        "dns.resp.type": ["1"],
      })),
    ),
  );
  expect(result.dnsQueries[0]?.response_addresses).toHaveLength(101);
  expect(result.dnsQueries[0]?.response_address_count).toBe(101);
  expect(result.partial).toBe(false);
});

it("accepts exact machine packet counts and rejects scaled human counts", () => {
  const prefix =
    "File type: pcap\nFile encapsulation: Ethernet\nNumber of packets: ";
  expect(parseCapinfosOutput(`${prefix}20010`).packetCount).toBe(20010);
  expect(() => parseCapinfosOutput(`${prefix}20 k`)).toThrow(
    /machine-readable/u,
  );
});

it("excludes transport credentials without normalizing observed URL bytes", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      {
        "http.request.full_uri": [
          "http://user:password@Example.com/a/../b?token=local-evidence#keep",
        ],
      },
      {
        "http.request.full_uri": [
          "http://other:secret@Example.com/a/../b?token=local-evidence#keep",
        ],
      },
    ]),
  );
  expect(result.httpRequestUris).toEqual([
    "http://Example.com/a/../b?token=local-evidence#keep",
  ]);
  expect(result.httpRequestUriCount).toBe(2);
  expect(result.httpUriRedactionCount).toBe(2);
  expect(result.partial).toBe(true);
});

it("retains HTTP absolute-form request targets when Wireshark cannot synthesize full_uri", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      { "http.request.uri": ["http://proxy.example.test/a/../resource"] },
      { "http.request.uri": ["/relative/path"] },
    ]),
  );
  expect(result.httpRequestUris).toEqual([
    "http://proxy.example.test/a/../resource",
  ]);
  expect(result.httpRequestUriCount).toBe(1);
  expect(result.partial).toBe(true);
});

it("marks mixed request arrays partial when a relative target has no full URI", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      {
        "http.request.uri": ["/resolved/with-host", "/unresolved/without-host"],
        "http.request.full_uri": ["http://host.example/resolved/with-host"],
      },
    ]),
  );
  expect(result.httpRequestUris).toEqual([
    "http://host.example/resolved/with-host",
  ]);
  expect(result.partial).toBe(true);
});

it("accounts for paired full URIs and absolute-form values without inventing array joins", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      {
        "http.request.uri": ["/first", "/second", "http://proxy.example/third"],
        "http.request.full_uri": [
          "http://host.example/first",
          "http://host.example/second",
          "http://proxy.example/third",
        ],
      },
    ]),
  );
  expect(result.httpRequestUris).toEqual([
    "http://host.example/first",
    "http://host.example/second",
    "http://proxy.example/third",
  ]);
  expect(result.partial).toBe(false);
});

it("refuses dense JSON before its expanded graph exceeds the decoding budget", async () => {
  await expect(
    parseTsharkJsonOutput(`[${"{},".repeat(600_000)}{}]`),
  ).rejects.toMatchObject({
    _tag: "AnalysisResourceConstraintError",
  });
});

it.each([
  null,
  "stopped",
  new ProviderCleanupError("caller", ["foreign-resource"], {}),
])(
  "preserves opaque cancellation while validating producer output: %s",
  async (reason) => {
    const controller = new AbortController();
    const result = parseTsharkJsonOutput(
      capture([{ "ip.src": ["192.0.2.1"] }]),
      controller.signal,
    );
    controller.abort(reason);
    const failure = await result.catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    if (!(failure instanceof AnalysisCancelledError)) throw failure;
    expect(failure.cause).toBe(reason);
    expect(failure.cleanupIncomplete).toBe(false);
    expect(failure.cleanupResources).toEqual([]);
    if (reason instanceof ProviderCleanupError)
      expect(reason.cleanupIncomplete).toBe(true);
  },
);

it("includes decoded HTTP/2 URIs with shared credential handling and reports unresolved targets", async () => {
  const full = await parseTsharkJsonOutput(
    capture([
      {
        "http2.request.full_uri": [
          "http://example.test/h2",
          "https://user:pass@example.test/kept",
        ],
        "http2.headers.path": ["/h2", "/kept"],
      },
      { "http.request.full_uri": ["http://example.test/h1"] },
    ]),
  );
  expect(full.httpRequestUris).toEqual([
    "http://example.test/h2",
    "https://example.test/kept",
    "http://example.test/h1",
  ]);
  expect(full.httpRequestUriCount).toBe(3);
  expect(full.httpUriRedactionCount).toBe(1);
  expect(full.partial).toBe(false);
  expect(
    (
      await parseTsharkJsonOutput(
        capture([{ "http2.headers.path": ["/unresolved"] }]),
      )
    ).partial,
  ).toBe(true);
});
