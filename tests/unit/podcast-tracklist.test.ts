import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatTracklist, validateTracklist } from "@/modules/podcasts/tracklist";
import historical from "../fixtures/podcast-tracklists.json";
const fixture = readFileSync(new URL("../fixtures/podcast-tracklist.txt", import.meta.url), "utf8");
const error = (text: string) => validateTracklist(text).errors.map(e => e.message).join("\n");
describe("bulk Podcast tracklist", () => {
  it("parses the exact 12-track fixture without losing punctuation or feature/remix text", () => {
    const result = validateTracklist(fixture); expect(result.errors).toEqual([]); expect(result.chapters).toHaveLength(12);
    expect(result.chapters.map(c => c.position)).toEqual(Array.from({ length:12 },(_,i)=>i));
    expect([0,1,9,10,11].map(i=>result.chapters[i]!.durationMs)).toEqual([0,170000,2659000,3019000,6820000]);
    expect(result.chapters[4]).toMatchObject({artist:"Thomas Schwartz, Fausto Fanizza",title:"Winter Fields feat. Phoebe Tsen (Nick Devon Remix)"});
  });
  it.each(["00:00","59:59","50:43","01:00:00","01:02:03","75:12"])("accepts timestamp %s", start => expect(validateTracklist(`D-Nox - A - B (Mix) 1;${start}`).errors).toEqual([]));
  it("identifies the colon typo without silently fixing it", () => { expect(error("A - B 1:00:00")).toContain('Did you mean: 1;00:00?'); expect(validateTracklist("A - B 1:00:00").chapters).toEqual([]); });
  it.each(["A - B 1,00:00","A - B ;00:00","A - B x;00:00","A - B 0;00:00","A - B -1;00:00","A - B 1;","A - B 1;0:00","A - B 1;01:60:20","A - B 1;01:53:75","A - B 1;00:60","1;00:00","A 1;00:00","A - 1;00:00","A - B 1;00:00 trailing"])("rejects malformed line %s", text => {const result=validateTracklist(text);expect(result.errors.length).toBeGreaterThan(0);expect(result.chapters).toEqual([]);});
  it("keeps physical line numbers while ignoring blanks", () => { expect(validateTracklist("\nA - B 1;00:00\n\nC - D 3;05:00").errors).toEqual([{line:4,message:"Track number 3 is out of sequence. Expected track number 2."}]); });
  it("rejects skipped and duplicate numbers", () => { expect(error("A - B 1;00:00\nA - C 2;05:00\nA - D 4;10:00")).toContain("Expected track number 3");expect(error("A - B 1;00:00\nA - C 2;05:00\nA - D 2;10:00")).toContain("duplicated"); });
  it.each(["10:00","15:00"])("rejects backward/equal start %s", start => expect(error(`A - B 1;00:00\nA - C 2;15:00\nA - D 3;${start}`)).toContain("Start times must move forward"));
  it("checks the exclusive audio duration bound and permits unknown duration", () => {expect(validateTracklist(fixture,6300000).errors.at(-1)?.message).toContain("Podcast duration of 01:45:00");expect(validateTracklist("A - B 1;00:01",1000).errors).toHaveLength(1);expect(validateTracklist(fixture,null).errors).toEqual([]);});
  it("treats only whitespace as intentionally empty", () => { expect(validateTracklist(" \n\t")).toEqual({chapters:[],errors:[]}); expect(error("malformed")).not.toBe(""); });
  it.each(historical)("round-trips migrated Podcast $legacyId", ({chapters}) => { expect(validateTracklist(formatTracklist(chapters),null,chapters)).toEqual({chapters,errors:[]}); });
  it("preserves unusual structured splits, legacy references and sub-second precision", () => {const original=[{position:0,artist:"Artist - Duo",title:"A - B",durationMs:1201,legacyReference:"HISTORICAL-7"}];expect(validateTracklist(formatTracklist(original),null,original).chapters).toEqual(original);});
  it("does not invent a timestamp for historical null start times", () => {const original=[{artist:"A",title:"B",durationMs:null}];expect(validateTracklist(formatTracklist(original),null,original).errors[0]?.message).toContain("missing");});
  it("bounds input size and database integer timestamps", () => {expect(error("A - B 1;9999999999:00")).toContain("too large");expect(error("x".repeat(300001))).toContain("too large");expect(error(Array.from({length:501},()=>"A - B 1;00:00").join("\n"))).toContain("500");});
});
