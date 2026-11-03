import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createTestDOM, render, click, changeInput, submitForm } from './setup.js';
import { FavoritesProvider } from '../src/context/FavoritesContext.jsx';
import { PlayerProvider } from '../src/context/PlayerContext.jsx';
import { TrackRow } from '../src/components/cards/TrackRow.jsx';
import { EditTrackModal } from '../src/components/modals/EditTrackModal.jsx';
import { setAuthToken } from '../src/api.js';

test('track menu offers tag editing for supported formats to administrators', async () => {
  for (const [format, admin, expected] of [
    ['mp3',true,true],['flac',true,true],['OPUS',true,true],['ogg',true,true],['m4a',true,true],
    ['wav',true,false],['wma',true,false],['flac',false,false],
  ]) {
    createTestDOM();setAuthToken(null);
    globalThis.fetch = async () => ({ok:true,json:async()=>({})});
    let selected;
    const track={id:1,title:'Test',format};
    const view=await render(
      <FavoritesProvider><PlayerProvider><table><tbody>
        <TrackRow track={track} user={{is_admin:admin}} onEditTags={value=>selected=value} />
      </tbody></table></PlayerProvider></FavoritesProvider>
    );
    try {
      await click(view.container.find(el=>el.getAttribute('aria-label')==='Actions for Test'));
      const edit=document.body.find(el=>el.tagName==='BUTTON'&&el.textContent==='Edit Tags');
      assert.equal(Boolean(edit),expected,format+':'+admin);
      if(edit){await click(edit);assert.equal(selected,track);}
    } finally {await view.unmount();}
  }
});

test('non-MP3 tag modal submits only changed fields and uses format-neutral wording', async () => {
  createTestDOM();setAuthToken(null);
  const requests=[];
  globalThis.fetch=async(url,opts)=>{requests.push({url,body:JSON.parse(opts.body)});return {ok:true,json:async()=>({success:true})};};
  let saved=false;
  const view=await render(<EditTrackModal track={{id:5,file_name:'song.flac',format:'flac',title:'Original',artist:'Artist',year:2023}} onSaved={()=>saved=true} onClose={()=>{}} />);
  try{
    assert.ok(document.body.textContent.includes('Edit Tags'));
    assert.ok(!document.body.textContent.includes('ID3'));
    const title=document.body.find(el=>el.tagName==='INPUT'&&el.value==='Original');
    await changeInput(title,'Новое название');
    await submitForm(document.body.find(el=>el.tagName==='FORM'));
    assert.deepEqual(requests,[{url:'/api/tags/5',body:{title:'Новое название'}}]);
    assert.equal(saved,true);
  }finally{await view.unmount();}
});
