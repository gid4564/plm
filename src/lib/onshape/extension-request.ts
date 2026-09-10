/**
 * Reading the context out of an Onshape app-extension call.
 *
 * Onshape's action-URL contract varies by extension location and by how the
 * extension was registered: the part number generator is documented as posting
 * a JSON body, a context menu substitutes placeholders into the URL, and a POST
 * context menu carries an Action Body instead. One reader covers all of them, so
 * a route does not silently see nothing because the caller chose a shape it did
 * not anticipate.
 *
 * The diagnostic string matters as much as the values. A route that logs only
 * the fields it wanted cannot distinguish "no body was sent" from "a body
 * arrived with different key names" from "the body was not JSON" — and those
 * need completely different fixes. This reports the method, the content type,
 * and the keys that actually arrived.
 */

export type ExtensionRequest = {
  /** First usable value for a key, from the body then the query string. */
  read: (key: string) => string;
  /** Everything that arrived, for logging and for fields not read by name. */
  raw: Record<string, unknown>;
  /** One line naming the method, content type, and keys seen. */
  describe: () => string;
};

/**
 * True when a value is absent or is a placeholder Onshape did not substitute.
 *
 * Onshape leaves a {$token} verbatim when it has nothing to put there — an
 * element with no configurations sends the literal "{$configuration}" — and
 * passing that on makes the follow-up Onshape call fail with a 400. So an
 * unsubstituted placeholder counts as absent wherever it appears.
 */
function unusable(v: unknown): boolean {
  const raw = String(v ?? "").trim();
  return !raw || /^\{\$.*\}$/.test(raw);
}

export async function readExtensionRequest(req: Request): Promise<ExtensionRequest> {
  const url = new URL(req.url);
  const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim() || "(none)";

  /*
   * Read the body as text once, then decide what it is.
   *
   * req.json() consumes the stream, so a failed parse leaves nothing to fall
   * back on and nothing to report — which is how the original version turned
   * every malformed or unexpected body into an empty object.
   */
  let bodyText = "";
  try {
    bodyText = await req.text();
  } catch {
    bodyText = "";
  }

  let body: Record<string, unknown> = {};
  let bodyKind = "empty";

  if (bodyText.trim()) {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
        bodyKind = "json";
      } else {
        bodyKind = `json-but-${Array.isArray(parsed) ? "array" : typeof parsed}`;
      }
    } catch {
      /*
       * Not JSON. A form-encoded body is the likely alternative — that is what a
       * caller sends when it treats the action URL as an HTML form post.
       *
       * But URLSearchParams accepts very nearly anything: a string with no "="
       * becomes a single key with an empty value, so an HTML error page or a
       * stack trace parses "successfully" into one nonsense field. That is worse
       * than failing, because a non-empty key list suppresses the raw-body
       * diagnostic that would have identified it.
       *
       * So a body only counts as form-encoded if it looks like key/value data:
       * at least one pair with a value. And a content type that claims JSON is
       * taken at its word — if it says JSON and does not parse as JSON, the
       * useful thing to report is the bytes, not a guess.
       */
      const claimsJson = contentType.includes("json");
      let parsedForm: Record<string, string> | null = null;

      if (!claimsJson && bodyText.includes("=")) {
        try {
          const entries = [...new URLSearchParams(bodyText).entries()];
          const looksLikeForm =
            entries.length > 0 && entries.some(([k, v]) => k.trim() !== "" && v.trim() !== "");
          if (looksLikeForm) parsedForm = Object.fromEntries(entries);
        } catch {
          parsedForm = null;
        }
      }

      if (parsedForm) {
        body = parsedForm;
        bodyKind = "form-encoded";
      } else {
        bodyKind = claimsJson ? "invalid-json" : "unrecognised";
      }
    }
  }

  const query = Object.fromEntries(url.searchParams.entries());

  return {
    read: (key: string) => {
      if (!unusable(body[key])) return String(body[key]).trim();
      if (!unusable(query[key])) return String(query[key]).trim();
      return "";
    },
    raw: { ...query, ...body },
    describe: () =>
      `${req.method} content-type=${contentType} body=${bodyKind}` +
      `(${bodyText.length}b) ` +
      `bodyKeys=[${Object.keys(body).join(",")}] ` +
      `queryKeys=[${Object.keys(query).join(",")}]` +
      // The first 200 characters of an unrecognised body are what identify a
      // shape nothing here anticipated. Only logged when parsing did not
      // produce usable keys, so a normal call logs no payload.
      (Object.keys(body).length === 0 && bodyText.trim()
        ? ` rawBody=${JSON.stringify(bodyText.slice(0, 200))}`
        : ""),
  };
}
