import type { IColorInput } from '../../store/color-inputs.js';

export interface SceneEvidence {
  version: 'scene-description-v1';
  presenter: 'yes' | 'uncertain' | 'unsupported';
  forwardDrive: boolean;
  indoor: boolean; outdoor: boolean; cabin: boolean;
  day: boolean; night: boolean; twilight: boolean;
  sceneChange: boolean;
  whiteSceneAmbiguous: boolean;
  evidence: { field: string; text: string; cues: string[]; startMs?: number; endMs?: number }[];
}
// Scene semantics only. Exposure/noise/cast labels never enter these predicates.
const patterns = {
  presenter: /(?:对着?|面向|面对)(?:镜头|相机|摄像机).{0,18}(?:讲|说|介绍|口播)|(?:人物|男子|男人|女子|女人|男士|女士|讲述者|主持人).{0,30}(?:正在讲解|正在讲述|口播|向观众介绍)|(?:speaking|talking|explaining|addressing).{0,35}(?:to (?:the )?(?:camera|audience)|directly (?:at|to) (?:the )?camera)|(?:on.camera (?:speaker|presenter)|(?:man|woman|person|speaker|presenter) (?:is |can be seen )?(?:speaking|talking|explaining|presenting|describing|speaks|explains|talks|describes))|\b(?:presenter|host)\b[^.!?。！？]{0,100}\b(?:speaking|talking|explaining|presenting|addressing)\b/iu,
  forwardDrive: /(?:前挡|前风挡|挡风玻璃|前风窗|车头视角|前方道路|道路前方|引擎盖|车头.{0,12}前景)|(?:windshield|windscreen|dashboard view|road ahead|hood in the foreground|forward.facing)/iu,
  indoor: /(?:室内|餐厅|饭店|餐馆|房间|车库|停车库|地下停车|隧道)|(?:indoors?|restaurant|dining (?:room|area)|parking garage|underground (?:parking|garage)|tunnel)/iu,
  cabin: /(?:车内|驾驶座)|(?:driver.s seat|inside (?:a |the )?car)/iu,
  outdoor: /(?:室外|户外|街道|道路|公路|山峦|山脉|山坡|天空|海面|湖泊|河流|风景|庭院|院落|森林|海岸|沙滩)|(?:outdoors?|street|road|highway|mountains?|hills|sky|landscape|lake|river|ocean|courtyard|garden|forest|coast|beach)/iu,
  day: /(?:白天|日间|日光|阳光|正常照明|灯光明亮|明亮的室内)|(?:daylight|daytime|well.lit|sunlit|brightly lit)/iu,
  night: /(?:夜间|夜晚|夜景|深夜)|(?:\bnight\b|nighttime|night.time|after dark)/iu,
  twilight: /(?:日出|日落|黎明|晨曦|朝霞|晚霞|黄昏|暮色)|(?:sunrise|sunset|dawn|dusk|twilight)/iu,
  sceneChange: /(?:进入|驶入|驶出|离开|穿过|进出).{0,15}(?:隧道|车库|地下停车)|(?:从|由).{0,30}(?:白天|明亮|室外).{0,30}(?:转为|变成|进入).{0,15}(?:夜|暗|室内)|(?:enter(?:s|ing)?|exit(?:s|ing)?|into|out of).{0,25}(?:tunnel|parking garage|underground)|(?:day.{0,10}to.night|night.{0,10}to.day)/iu,
  whiteSceneAmbiguous: /(?:白墙|白色背景|雪地|雪原|浓雾|云海|满屏天空|只见天空)|(?:white wall|white background|snowfield|snow.covered|dense fog|thick fog|sea of clouds|only (?:the )?sky)/iu,
};
const uncertain = /(?:可能|似乎|好像|疑似|仿佛|无法确定|不确定)|(?:appears? to|seems? to|possibly|perhaps|might|unclear|uncertain)/iu;
const negated = /(?:并非|不是|并不|没有|未见|未在|不在|无).{0,12}$|(?:no|not|without|isn't|is not|doesn't|does not|never)\s+(?:\w+\s+){0,3}$/iu;

export function readSceneEvidence(input: IColorInput): SceneEvidence {
  const facts = input.facts;
  const result: SceneEvidence = { version: 'scene-description-v1', presenter: 'unsupported', forwardDrive: false,
    indoor: false, outdoor: false, cabin: false, day: false, night: false, twilight: false, sceneChange: false,
    whiteSceneAmbiguous: false, evidence: [] };
  if (!facts) return result;
  const sources = [{ field: 'summary', text: facts.summary ?? '', speech: facts.speech.hasTranscript || facts.speech.ranges.length > 0,
    startMs: undefined as number | undefined, endMs: undefined as number | undefined },
  ...facts.visualWindows.map(w => ({ field: `visualWindows.${w.windowId}`, text: w.visualObservation ?? '',
    speech: w.speech.hasTranscript || w.speech.ranges.length > 0, startMs: w.sourceInMs, endMs: w.sourceOutMs }))];
  let certainPresenter = false, uncertainPresenter = false, negativePresenter = false, summaryPresenter = false;
  const presenterRanges: { startMs: number; endMs: number }[] = [];
  for (const source of sources) {
    for (const sentence of source.text.split(/(?<=[。！？!?])|(?<=\.)\s+/u).map(s => s.trim()).filter(Boolean)) {
      const cues: string[] = [];
      for (const [key, pattern] of Object.entries(patterns)) {
        const match = pattern.exec(sentence);
        if (!match) continue;
        const isNegated = negated.test(sentence.slice(Math.max(0, match.index - 55), match.index))
          || /(?:并未|没有|并不|未曾|不是)|\b(?:not|never|without)\b/iu.test(match[0]);
        const isUncertain = uncertain.test(sentence);
        if (key === 'presenter') {
          if (isNegated) negativePresenter = true;
          else if (isUncertain || !source.speech) uncertainPresenter = true;
          else {
            certainPresenter = true;
            if (source.field === 'summary') summaryPresenter = true;
            else if (source.startMs !== undefined && source.endMs !== undefined) presenterRanges.push({ startMs: source.startMs, endMs: source.endMs });
          }
        }
        if (!isNegated && !isUncertain) {
          if (key !== 'presenter') (result as unknown as Record<string, unknown>)[key] = true;
          cues.push(key);
        } else cues.push(`${key}:${isNegated ? 'negated' : 'uncertain'}`);
      }
      if (cues.length) result.evidence.push({ field: source.field, text: sentence, cues, startMs: source.startMs, endMs: source.endMs });
    }
  }
  let covered = 0, end = 0;
  for (const r of presenterRanges.sort((a, b) => a.startMs - b.startMs)) {
    covered += Math.max(0, r.endMs - Math.max(end, r.startMs)); end = Math.max(end, r.endMs);
  }
  const wholePresenter = summaryPresenter || (input.media.durationMs && covered / input.media.durationMs >= 0.8);
  result.presenter = certainPresenter && wholePresenter && !negativePresenter ? 'yes'
    : uncertainPresenter || certainPresenter || facts.type === 'talking-head' ? 'uncertain' : 'unsupported';
  return result;
}
