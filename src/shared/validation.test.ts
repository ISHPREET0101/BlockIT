import { describe, expect, it } from 'vitest';
import { csvCell, defaultSettings, nodeIdentifier, scanIdentifier, settingsPatch, validateQuery } from './validation';
import { insideRoot } from '../../electron/path-safety';

const scanId='00000000-0000-4000-8000-000000000001';
describe('IPC and preference validation',()=>{
  it('rejects malformed and traversal scan IDs',()=>{
    for(const id of ['../other','-'.repeat(36),null,123,{},'00000000-0000-4000-8000-00000000000z']) expect(()=>scanIdentifier(id)).toThrow();
    expect(scanIdentifier(scanId)).toBe(scanId);
  });
  it('only accepts positive integer node IDs',()=>{
    for(const id of [-1,0,1.1,NaN,Infinity,'1',null]) expect(()=>nodeIdentifier(id)).toThrow();
    expect(nodeIdentifier(123)).toBe(123);
  });
  it('rejects invalid filters and SQL-like sort inputs',()=>{
    for(const patch of [{sortBy:'size; DROP TABLE nodes'}, {sortDir:'sideways'}, {page:NaN}, {page:-1}, {minSize:Infinity}, {kind:'device'}, {category:'Unknown'}, {search:{}}, {olderThan:NaN}]) {
      expect(()=>validateQuery({scanId,...patch})).toThrow();
    }
  });
  it('preserves zero boundaries and caps renderer page sizes',()=>{
    const query=validateQuery({scanId,minSize:0,olderThan:0,pageSize:100000,extension:' .MP4 '});
    expect(query).toMatchObject({minSize:0,olderThan:0,pageSize:500,extension:'mp4'});
  });
  it('validates settings without exposing a confirmation bypass',()=>{
    expect(settingsPatch({theme:'dark',confirmRecycle:false,arbitraryPath:'C:/'})).toEqual({theme:'dark',confirmRecycle:true});
    expect(settingsPatch(defaultSettings)).toEqual(defaultSettings);
    for(const patch of [{theme:'system'}, {showTreemap:1}, {oldFileDays:NaN}, {largeFileThreshold:0}, null, []]) expect(()=>settingsPatch(patch)).toThrow();
  });
});
describe('path containment',()=>{
  it('permits dot-prefixed child names but rejects siblings and ancestors',()=>{
    expect(insideRoot('C:/scan','C:/scan/..notes/file.txt')).toBe(true);
    expect(insideRoot('C:/scan','C:/scan-other/file.txt')).toBe(false);
    expect(insideRoot('C:/scan','C:/scan/../secret')).toBe(false);
    expect(insideRoot('C:/scan','C:/scan',false)).toBe(false);
    expect(insideRoot('C:/scan','C:/scan')).toBe(true);
  });
});
describe('CSV output',()=>{
  it('escapes delimiters and spreadsheet formulas, including leading whitespace',()=>{
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    for(const formula of ['=1+2',' +SUM(1)','\t=1','-2','@x']) expect(csvCell(formula)).toContain("'");
    expect(csvCell('ordinary.txt')).toBe('ordinary.txt');
  });
});
