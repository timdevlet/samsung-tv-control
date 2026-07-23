import type { Ref } from "react";
import { Field } from "../../components/Field";
import { PasswordInput } from "../../components/PasswordInput";
import { TextInput } from "../../components/TextInput";

// The SmartThings OAuth client fields, tucked behind the Account group's "Show additional
// options" disclosure.
export function OAuthClientFields({
  clientId,
  clientSecret,
  redirectUri,
  onChange,
  clientIdRef,
}: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  onChange: (field: "clientId" | "clientSecret" | "redirectUri", value: string) => void;
  // For the reveal-and-focus behavior when Sign in routes here with no client configured.
  clientIdRef: Ref<HTMLInputElement>;
}) {
  return (
    <>
      <p className="hint">To get a Client ID and Client Secret:</p>
      <ol className="hint">
        <li>
          Create an “OAuth-In” SmartApp in the SmartThings Developer Workspace
          (developer.smartthings.com) or with the SmartThings CLI (smartthings apps:create).
        </li>
        <li>
          Give it the scopes r:devices:*, x:devices:* and r:locations:*, and register a redirect URI
          — the default https://httpbin.org/get works.
        </li>
        <li>
          Copy the Client ID and Client Secret it generates (the secret is shown only once) into the
          fields below, then use Sign in above to approve access — tokens are stored automatically.
        </li>
      </ol>
      <Field label="Client ID" htmlFor="clientId">
        <TextInput
          id="clientId"
          ref={clientIdRef}
          value={clientId}
          onValueChange={(v) => onChange("clientId", v)}
        />
      </Field>
      <Field label="Client Secret" htmlFor="clientSecret">
        <PasswordInput
          id="clientSecret"
          value={clientSecret}
          onValueChange={(v) => onChange("clientSecret", v)}
        />
      </Field>
      <Field label="Redirect URI" htmlFor="redirectUri">
        <TextInput
          id="redirectUri"
          value={redirectUri}
          onValueChange={(v) => onChange("redirectUri", v)}
        />
      </Field>
    </>
  );
}
