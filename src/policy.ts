const DEFAULT_SCHEMA = `namespace Jans {
entity Role;

entity User in [Role] = {
  role: String
};
}

entity Tool = {
  name: String,
  risk: String
};

action "Invoke" appliesTo {
  principal: [Jans::User],
  resource: [Tool],
  context: {
    now: Long,
    tool: String,
    risk: String,
  }
};
`;

const DEFAULT_POLICIES: string[] = [];

const POLICY_STORE_ID = "clawclamp";

type EncodedContent = {
  encoding: "none" | "base64";
  content_type: "cedar" | "cedar-json";
  body: string;
};

function toBase64(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64");
}

function buildSchemaContent(): EncodedContent {
  return {
    encoding: "none",
    content_type: "cedar",
    body: DEFAULT_SCHEMA,
  };
}

export function buildDefaultPolicyStore(): Record<string, unknown> {
  const policies: Record<
    string,
    {
      cedar_version: string;
      name: string;
      description: string;
      policy_content: string;
    }
  > = {};
  DEFAULT_POLICIES.forEach((policy, index) => {
    policies[`openclaw-clawclamp-${index + 1}`] = {
      cedar_version: "v4.0.0",
      name: `Clawclamp Default Policy ${index + 1}`,
      description: "Default grant-based permit policy.",
      policy_content: toBase64(policy),
    };
  });

  return {
    cedar_version: "v4.0.0",
    policy_stores: {
      [POLICY_STORE_ID]: {
        name: "Clawclamp Policy Store",
        description: "Local Cedar policies for Clawclamp.",
        policies,
        schema: buildSchemaContent(),
        trusted_issuers: {},
      },
    },
  };
}
