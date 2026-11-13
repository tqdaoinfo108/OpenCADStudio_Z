import { randomUUID } from 'node:crypto';
import { compileFurnitureGlb, BLUEPRINT_MATERIALS } from '../scripts/bake_glb_assets.mjs';

const instruction = `Generate a detailed FurnitureBlueprint for the Vietnamese request. Output one JSON object, no markdown, with name (Vietnamese), category (living_room, kitchen_dining, bedroom, worship_rooftop, bathroom_laundry, greenery_architectural), placement_type (floor_wall_backed or floor_free), furniture_kind (sofa, coffee_table, tv_cabinet, rug, plant, bed, wardrobe, nightstand, desk, dressing_table, kitchen_cabinet, fridge, dining_table, island, altar, toilet, lavabo, shower, bathtub, washing_machine, bbq or patio), and size: [width X, height Y, depth Z] in meters. Back is -Z, front +Z, bottom Y=0. User dimension order is width × depth × height unless specified. Each of 1–80 parts uses type, material, position [X,Y,Z], optional rotation radians [X,Y,Z]. rounded_box or foliage_cluster uses size [X,Y,Z]; tapered_cylinder or angled_leg uses size [top radius, height, bottom radius]; lathe_profile uses points [[radius,Y],...]; curved_tube and arch_frame use points [[X,Y,Z],...] and radius. Model legs, base, frame, cushions, back, fittings and requested accessories as separate parts. Allowed materials: ${Object.keys(BLUEPRINT_MATERIALS).join(', ')}.`;

export async function generateFurniture(prompt, config) {
  const base = config?.base_url?.replace(/\/+$/, '');
  const model = config?.primary_model;
  if (!base || !model) throw new Error('Hãy cấu hình nhà cung cấp AI trước khi tạo nội thất.');
  const key = config.api_key || (new URL(base).hostname === 'api.openai.com' ? process.env.OPENAI_API_KEY : '');
  const headers = { 'Content-Type': 'application/json' };
  const messages = [{ role: 'system', content: instruction }, { role: 'user', content: prompt }];
  let url = base.endsWith('/chat/completions') ? base : base + '/chat/completions';
  let body = { model, messages };
  if (key) headers.Authorization = 'Bearer ' + key;
  if (config.provider === 'ollama' && !base.endsWith('/v1')) {
    url = base.replace(/\/api(?:\/chat)?$/, '') + '/api/chat';
    body = { model, messages, stream: false, format: 'json' };
  } else if (new URL(base).hostname === 'api.anthropic.com') {
    url = base.endsWith('/messages') ? base : base.replace(/\/v1$/, '') + '/v1/messages';
    headers['x-api-key'] = key || '';
    headers['anthropic-version'] = '2023-06-01';
    body = { model, system: instruction, messages: [messages[1]], max_tokens: 5000 };
  } else if (new URL(base).hostname === 'generativelanguage.googleapis.com' && !base.endsWith('/openai')) {
    url = new URL('/v1beta/models/' + encodeURIComponent(model.replace(/^models\//, '')) + ':generateContent', base);
    headers['x-goog-api-key'] = key || '';
    body = { systemInstruction: { parts: [{ text: instruction }] }, contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' } };
  }
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error('Nhà cung cấp AI trả về HTTP ' + response.status + '.');
  const output = await response.json();
  const content = output.choices?.[0]?.message?.content ?? output.message?.content ??
    output.content?.filter(part => part.type === 'text').map(part => part.text).join('') ??
    output.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('');
  if (typeof content !== 'string') throw new Error('Nhà cung cấp AI chưa trả về blueprint.');
  const blueprint = JSON.parse(content.trim().replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/gi, ''));
  const id = 'generated_' + randomUUID().replaceAll('-', '');
  const glb = compileFurnitureGlb(blueprint, id);
  const [width,height,depth] = blueprint.size;
  const categories = ['living_room','kitchen_dining','bedroom','worship_rooftop','bathroom_laundry','greenery_architectural'];
  const category = categories.includes(blueprint.category) ? blueprint.category : 'living_room';
  const name = typeof blueprint.name === 'string' ? blueprint.name.replace(/[<>"]/g, '').trim().slice(0,100) : '';
  return { glb, asset: {
    id, asset_id: id, name: name || 'Nội thất AI', category, asset_type:'model', tags:['AI',category, 'kind:' + (typeof blueprint.furniture_kind === 'string' && /^[a-z_]{1,32}$/.test(blueprint.furniture_kind) ? blueprint.furniture_kind : 'sofa')],
    room_types:[category], placement_type: blueprint.placement_type === 'floor_free' ? 'floor_free' : 'floor_wall_backed',
    dimensions:{width,height,depth}, size_x:width, size_y:height, size_z:depth, is_builtin:0
  }};
}
