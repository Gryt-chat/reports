import { Alert, Button, Card, TextField } from "@gryt/ui";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api, type Person } from "../lib/api";
import { fullDate } from "../lib/format";

/**
 * Who can read this.
 *
 * Keycloak says who somebody is; this list says whether they get in. A Gryt
 * account is not enough on its own, which is the point — anybody can make one.
 */
export function People() {
  const [people, setPeople] = useState<Person[]>([]);
  const [identifier, setIdentifier] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    try {
      setPeople((await api.people()).people);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!identifier.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addPerson(identifier.trim(), note.trim() || null);
      setIdentifier("");
      setNote("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(person: Person) {
    setError(null);
    try {
      await api.removePerson(person.id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="stage__wrap">
      <p className="stage__label">Access</p>
      <h1>Who can read this</h1>
      <p className="rail__who" style={{ marginTop: "0.5rem" }}>
        Everyone here signs in with their Gryt account. Anyone else is turned
        away, whether or not they have one.
      </p>

      {error ? (
        <Alert severity="error" style={{ marginTop: "1rem" }}>
          {error}
        </Alert>
      ) : null}

      <div className="people">
        {people.map((person) => (
          <div className="person" key={person.id}>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0 }}>{person.name ?? person.identifier}</p>
              <p className="person__id">
                {person.subject ?? person.identifier}
                {person.note ? ` · ${person.note}` : ""}
              </p>
              <p className="rail__who">
                {person.last_seen_at
                  ? `last here ${fullDate(person.last_seen_at)}`
                  : "has not signed in yet"}
                {person.added_by ? ` · added by ${person.added_by}` : ""}
              </p>
            </div>
            <Button
              size="small"
              tone="danger"
              onClick={() => void remove(person)}
            >
              Remove
            </Button>
          </div>
        ))}
        {people.length === 0 ? (
          <p className="rail__who">Nobody yet.</p>
        ) : null}
      </div>

      <Card style={{ padding: "1rem" }}>
        <form onSubmit={add}>
          <p className="stage__label">Add somebody</p>
          <div className="decide">
            <div className="decide__note">
              <TextField
                label="Who"
                placeholder="Keycloak user id, username or email"
                size="small"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                required
              />
            </div>
            <div className="decide__note">
              <TextField
                label="Note"
                placeholder="Who they are"
                size="small"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <Button type="submit" size="small" tone="primary" disabled={busy}>
              {busy ? "Adding…" : "Add"}
            </Button>
          </div>
        </form>
        <p className="rail__who" style={{ marginTop: "0.75rem" }}>
          A username or email works before they have ever signed in. The first
          time they do, this pins to their user id — the one thing about an
          account nobody can change afterwards.
        </p>
      </Card>

      <p style={{ marginTop: "1.5rem" }}>
        <Link className="rail__who" to="/">
          ← Back to the inbox
        </Link>
      </p>
    </div>
  );
}
