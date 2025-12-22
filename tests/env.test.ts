import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseEnvContent, parseEnvPairs } from "../src/env";

const fixturePath = path.join(process.cwd(), "tests", "fixtures", "ai.env");
const fixture = fs.readFileSync(fixturePath, "utf8");

test("parseEnvContent parses .env content", () => {
  const env = parseEnvContent(fixture);

  assert.equal(env.OPENAI_API_KEY, "abc123");
  assert.equal(env.HTTP_PROXY, "http://localhost:8080");
  assert.equal(env.QUOTED, "hello world");
  assert.equal(env.SINGLE, "keep # hash");
  assert.equal(env.EMPTY, "");
  assert.equal(env.TRAILING, "foo");
  assert.equal(env.ESCAPED, "line1\nline2");
});

test("parseEnvPairs parses key=value pairs", () => {
  const env = parseEnvPairs(["FOO=bar", "HTTP_PROXY=http://a=b"]);

  assert.equal(env.FOO, "bar");
  assert.equal(env.HTTP_PROXY, "http://a=b");
});

test("parseEnvPairs throws on invalid input", () => {
  assert.throws(() => parseEnvPairs(["BADPAIR"]));
});
