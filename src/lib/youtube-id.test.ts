import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { demoVideoId, youtubeId } from "./youtube-id.ts";

const ID = "dQw4w9WgXcQ";

describe("youtubeId", () => {
  it("accepts a bare id and the usual YouTube URLs", () => {
    assert.equal(youtubeId(`  ${ID} `), ID);
    assert.equal(youtubeId(`https://www.youtube.com/watch?v=${ID}&t=12`), ID);
    assert.equal(youtubeId(`https://youtu.be/${ID}`), ID);
    assert.equal(youtubeId(`https://www.youtube.com/embed/${ID}`), ID);
    assert.equal(youtubeId(`https://www.youtube.com/shorts/${ID}`), ID);
  });

  it("rejects other hosts, http, and short strings", () => {
    assert.equal(youtubeId("https://example.com/watch?v=" + ID), null);
    assert.equal(youtubeId("http://www.youtube.com/watch?v=" + ID), null);
    assert.equal(youtubeId("nope"), null);
    assert.equal(youtubeId(""), null);
    assert.equal(youtubeId(null), null);
  });
});

describe("demoVideoId", () => {
  it("prefers a valid query and falls back to the env id", () => {
    assert.equal(demoVideoId(ID, "abcdefghijk"), ID);
    assert.equal(demoVideoId("nope", "abcdefghijk"), "abcdefghijk");
    assert.equal(demoVideoId(undefined, ""), null);
    assert.equal(demoVideoId([`https://youtu.be/${ID}`], undefined), ID);
  });
});
