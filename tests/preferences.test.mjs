import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PEN_SETTINGS,normalizeHex,hexToRgb,rgbToHex,loadPenSettings,savePenSettings} from '../src/preferences.js';

const key='paper-pdf.pen-settings.v1';
function memoryStorage(initial=null) {
  const values=new Map(initial===null?[]:[[key,initial]]);
  return {getItem:name=>values.get(name)??null,setItem:(name,value)=>values.set(name,value)};
}

test('color normalization accepts exact HEX, shorthand and surrounding whitespace',()=>{
  for(const [input,expected] of [['#202b35','#202b35'],['A1b2C3','#a1b2c3'],[' #AbC \n','#aabbcc'],['000','#000000'],['#FFF','#ffffff']])assert.equal(normalizeHex(input),expected);
  for(const input of [null,undefined,123,true,'','#','#1','#12','#1234','#12345','#1234567','#12345678','##abc','#abg','red','rgb(1,2,3)','#12 3456'])assert.equal(normalizeHex(input),null);
});

test('RGB conversion preserves exact channel values and rejects incomplete or out-of-range channels',()=>{
  assert.deepEqual(hexToRgb('#a1B2c3'),{r:161,g:178,b:195});
  assert.deepEqual(hexToRgb('#abc'),{r:170,g:187,b:204});
  assert.equal(hexToRgb('#12'),null);
  assert.equal(rgbToHex(0,255,1),'#00ff01');
  assert.equal(rgbToHex(161,178,195),'#a1b2c3');
  for(const invalid of ['',null,undefined,true,'1',-1,256,1.5,NaN,Infinity]) {
    assert.equal(rgbToHex(invalid,0,0),null);
    assert.equal(rgbToHex(0,invalid,0),null);
    assert.equal(rgbToHex(0,0,invalid),null);
  }
});

test('missing, malformed or unsupported settings restore independent defaults',()=>{
  for(const raw of [null,'{','null','[]','true','42','"text"','{}','{"version":2,"color":"#fff"}','{"version":"1","color":"#fff"}'])assert.deepEqual(loadPenSettings(memoryStorage(raw)),DEFAULT_PEN_SETTINGS);
  const loaded=loadPenSettings(memoryStorage());loaded.color='#ffffff';
  assert.equal(DEFAULT_PEN_SETTINGS.color,'#202b35');
});

test('invalid settings fields fall back independently without discarding valid choices',()=>{
  const storage=memoryStorage(JSON.stringify({version:1,color:'#AbC',width:'2.5',penOnly:true}));
  assert.deepEqual(loadPenSettings(storage),{color:'#aabbcc',width:1.6,penOnly:true});
  storage.setItem(key,JSON.stringify({version:1,color:'invalid',width:2.34,penOnly:'true'}));
  assert.deepEqual(loadPenSettings(storage),{color:'#202b35',width:2.3,penOnly:false});
  for(const width of [0.7,6]){
    storage.setItem(key,JSON.stringify({version:1,color:'#000',width,penOnly:false}));
    assert.equal(loadPenSettings(storage).width,width);
  }
  for(const width of [0.69,6.01,null,'1.6']){
    storage.setItem(key,JSON.stringify({version:1,color:'#000',width,penOnly:false}));
    assert.equal(loadPenSettings(storage).width,1.6);
  }
});

test('saving and loading restores pen choices while persisting only the settings whitelist',()=>{
  const storage=memoryStorage();
  assert.equal(savePenSettings(storage,{color:'#1A2b3C',width:3.7,penOnly:true,filename:'private.pdf',pdf:'private bytes',tool:'eraser',version:99}),true);
  assert.deepEqual(JSON.parse(storage.getItem(key)),{version:1,color:'#1a2b3c',width:3.7,penOnly:true});
  assert.deepEqual(loadPenSettings(storage),{color:'#1a2b3c',width:3.7,penOnly:true});
  assert.equal(savePenSettings(storage,{color:'#fff',width:1.26,penOnly:false}),true);
  assert.deepEqual(loadPenSettings(storage),{color:'#ffffff',width:1.3,penOnly:false});
});

test('unavailable or failing browser storage never prevents editor startup or setting changes',()=>{
  for(const storage of [undefined,null,{}, {getItem(){throw new Error('blocked');},setItem(){throw new Error('quota');}}]){
    assert.deepEqual(loadPenSettings(storage),DEFAULT_PEN_SETTINGS);
    assert.equal(savePenSettings(storage,DEFAULT_PEN_SETTINGS),false);
  }
});
