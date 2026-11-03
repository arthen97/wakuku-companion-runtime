import {floorDecide} from './core/floor.js';

// Chinese rules extend the real Open Annie floor; they produce the same Jev
// answer shape and pass through its original confidence / refusal gates.
const c = (keys, value, confidence = .93) => ({type:'choice', choice:value, confidence,
  probabilities:Object.fromEntries(keys.map(k=>[k,k===value?confidence:(1-confidence)/Math.max(1,keys.length-1)]))});

export function localDecision(kind, text, questions) {
  const result = floorDecide(text, questions);
  const answers = result.answers;
  let face, clip, reaction, energy = 'moderate', veto = false;
  if (/(不跳|不做|不会跳|不能跳|不摇|不点|先不|不要|不用|不想|拒绝)/u.test(text)) {
    veto = true; clip = 'none'; reaction = 'none'; face = 'neutral';
  } else if (/(去世|葬礼|离世|失去亲人)/u.test(text)) {
    veto = true; face = 'sad'; reaction = 'empathize'; energy = 'gentle';
  } else if (kind === 'listen') {
    if (/(累|难过|烦|辛苦|害怕)/u.test(text)) {face='concerned'; energy='gentle';}
    else if (/(你好|在吗|早安|回来)/u.test(text)) face='happy';
    else if (/(开心|太好|成功)/u.test(text)) face='joyful';
  } else if (/(我(轻轻)?摇摇头|我摇头)/u.test(text)) {
    clip='headshake'; reaction='none';
  } else if (/(我(轻轻)?点点头|我点头|记住啦|记下了|记下啦)/u.test(text)) {
    clip='nod'; reaction='none'; face='tender';
  } else if (/(辛苦啦|我在听|安静陪|安静待|放下来|不催你)/u.test(text)) {
    clip='tilt'; reaction='none'; face='tender'; energy='gentle';
  } else if (/^(你好|早安|在呢|回来啦)|^(hi|hello|hey)\b/iu.test(text)) {
    clip='attend'; reaction='none'; face='happy';
  }
  for (const [name, value] of Object.entries({face,what:clip,reaction,energy})) {
    if (value !== undefined && questions[name]?.criteria && Object.hasOwn(questions[name].criteria,value))
      answers[name] = c(Object.keys(questions[name].criteria),value,name==='face'?.82:.93);
  }
  if (veto && questions.what) answers.what = c(Object.keys(questions.what.criteria),'none',.99);
  if (questions.performs && veto) answers.performs = {type:'noul',noul:.01};
  return {...result,source:'floor'};
}

export class TaitaiFloor {
  async decide(kind, ctx, questions) {
    const start = performance.now();
    const result = localDecision(kind,kind==='listen'?ctx.userText:ctx.assistantText,questions);
    return {...result,latency_ms:performance.now()-start};
  }
}
