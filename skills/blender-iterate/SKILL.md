---
name: blender-iterate
description: Model and animate in Blender through the blender-mcp tools with a strict small-step/validate-each-part discipline. Use for ANY Blender modeling, scene-building, or animation task driven via MCP (blender_execute_blender_code, blender_get_viewport_screenshot, etc.). Enforces one change at a time, a render-and-look validation after every step, and never bundling geometry + animation + camera work into one shot.
---

# Blender Modeling & Animation (iterate + validate)

Drive Blender via the `blender-*` MCP tools. The #1 failure mode is doing too
much in one shot and never validating, so the user has to catch every error.
This skill exists to prevent that. **Follow the loop, not the code.**

## The Iron Rules

1. **One concern per iteration.** Geometry (position/orientation), animation
   (keyframes), and render/camera settings are three separate concerns. A
   single `execute_blender_code` call does ONE of them, then you validate.
   If the user said "fix the nest position," do NOT also touch keyframes,
   the camera, or the render engine. Respect the stated scope exactly.
2. **Validate before proceeding.** After each change, render and actually
   LOOK at the image (read it back with your own vision). Judge it against a
   single explicit acceptance criterion. Only move to the next step once this
   one passes. Stacking unvalidated changes is how every error compounds.
3. **Never claim "validated" on something you haven't seen.** If your model
   can't view images, say so and use a real alternative (see *Vision gate*).
4. **Reference first.** If the user gave a sketch/reference/diagram, look at
   it BEFORE modeling. If you cannot see it, ask them to describe the key
   states in words before building. Build to match the reference, not your
   assumptions.

## Step 0 — Vision gate (do this once per session, first)

You cannot validate visually if you can't see. Test it:

```
read <a small .png you control>
```

- If you get a real image → proceed with normal visual validation.
- If you get "model does not support images" → you have NO vision. Do NOT
  guess. Either (a) ask the user to confirm, or (b) if a local vision
  endpoint is available, send the render there via curl and read the text
  answer — but label it as *proxy* validation, weaker than seeing it
  yourself. Tell the user which mode you are in.

## The validate loop (per step)

For each single change:

1. **State the criterion.** One sentence: "The nest bowl must open upward
   and sit close to the trunk."
2. **Make the ONE change.** Idempotent: delete/rebuild only the object(s)
   for this concern. Never rebuild the whole scene when one object changed.
3. **Render the current frame** (see *Render template* below) to a temp PNG.
4. **Read the image back** and judge the criterion. Pass/fail, in one line.
5. **On fail:** diagnose THAT one thing, change only it, re-render, re-look.
   Loop. **On pass:** move to the next concern.

Never skip step 4. Never bundle step 2 for multiple concerns.

## Animation validation (special case)

For any keyframed motion, validate the animation as its own concern:

- Render **frame_start AND frame_end** (two images) and look at both.
- **If the two frames are identical, the animation is not working** — stop
  and read back the actual fcurve values before doing anything else.
- Read keyframe values directly to confirm start ≠ end:

```python
import bpy
o = bpy.data.objects["NAME"]
a = o.animation_data.action
cb = a.layers[0].strips[0].channelbag(a.slots[0])   # Blender 4.5+/5.x
for fc in cb.fcurves:
    print(fc.data_path, fc.array_index,
          [(round(k.co.x,1), round(k.co.y,3)) for k in fc.keyframe_points])
```

- Symmetry check for "wings/petals opening": the two mirrored parts must
  rotate in **opposite** world directions (one left, one right). Verify by
  rendering the end frame and looking, not by assuming the signs are right.

## Blender 5.x API traps (don't guess — introspect)

When you hit `has no attribute`, **do not guess; introspect**:

```python
print([x for x in dir(obj) if not x.startswith('_')])
print([i.identifier for i in obj.bl_rna.properties['PROP'].enum_items])
```

Known 5.x breaks from older tutorials:
- Render engine names: `'BLENDER_EEVEE'`, `'BLENDER_WORKBENCH'`, `'CYCLES'`
  (NOT `'EEVEE'`/`'WORKBENCH'`).
- Workbench renders **flat gray** — useless for validating materials,
  colors, or "is X visible." Use **EEVEE** for validation renders.
- Action fcurves live under `action.layers[0].strips[0].channelbag(slot)`;
  `action.fcurves` and `action.runtime_channelbags` no longer exist.
- `obj.keyframe_insert('rotation_euler', frame=fr)` keys all 3 channels —
  you do not need `foreach_get`.
- After `bpy.data.objects.remove(ob)`, do not touch `ob` (dangling).
  Capture `ob.name` before removing.
- `bpy.ops.view3d.view_selected()` needs a VIEW_3D region — it will fail in
  MCP code execution. Use a camera render instead of viewport framing.

## Local-space vs world-space trap

Objects built inside another object's local frame inherit its orientation.
Classic bug: building a nest bowl along a branch's local +Z makes the bowl
open *along the branch* (sideways), not *upward*.

- For anything that must point a fixed world direction (bowl opening up,
  character standing up), **build it in world space** (no parent rotation),
  then join if needed — join preserves each part's world transform.
- Always confirm orientation with a render, never by reasoning about
  quaternions alone.

## Render template (for validation)

```python
import bpy
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x = 640          # low res = fast iteration
sc.render.resolution_y = 480
sc.render.resolution_percentage = 100
sc.frame_set(FRAME)                   # the frame you're validating
sc.render.filepath = f"/tmp/blender_iter_{FRAME}.png"
bpy.ops.render.render(write_still=True)
```

Then `read /tmp/blender_iter_{FRAME}.png`.

For animation: render both `sc.frame_start` and `sc.frame_end`, read both,
confirm they differ the way you intended.

## Hygiene

- Keep the user's selection/viewport/scene state clean — restore
  `frame_set` to the frame you found it on.
- Save the `.blend` after each **validated** milestone (ask where if unsure).
- Idempotent rebuilds: prefix your objects (e.g. `Tree_`, `Branch_`) and
  delete by prefix at the top of each rebuild so re-runs don't duplicate.
- Keep the tree of concerns separate in your head and in your replies:
  "Geometry: done. Animation: not started." Don't blur them.

## Reply style

Keep it tight: (1) the single change made, (2) the acceptance criterion,
(3) pass/fail with one line of what you actually saw in the render. No
tangents, no re-explaining the plan, no "let me also check the camera."
If you made an out-of-scope change, say so explicitly and offer to revert.
