# -*- coding: utf-8 -*-
"""
Author: jian wei
File Name:debug.py
"""
from jianyingdraft.jianying.draft import Draft
from jianyingdraft.jianying.track import Track
from jianyingdraft.jianying.audio import AudioSegment
from jianyingdraft.jianying.text import TextSegment
from jianyingdraft.jianying.export import ExportDraft
from jianyingdraft.jianying.video import VideoSegment

# 创建草稿
draft = Draft()
draft_id = draft.create_draft(draft_name='test')['draft_id']
print(draft_id)
# 创建轨道
text_track_id = Track(draft_id).add_track(track_type='text', track_name='text')
video_track_id = Track(draft_id).add_track(track_type='video', track_name='video')
Track(draft_id).add_track(track_type='audio', track_name='audio')
# 创建音频片段
audio_segment = AudioSegment(draft_id, track_name='audio')
audio_segment.add_audio_segment(material='../material/audio.MP3',
                                target_timerange='0s-16s')
audio_segment.add_fade('1s', '0.5s')
# 创建视频片段
video_segment1 = VideoSegment(draft_id, track_name='video')
video_segment1.add_video_segment(
    material='../material/video1.mp4',
    target_timerange='0s-6s'
)
video_segment1.add_transition('叠化', '1s')
video_segment1.add_filter('冬漫', intensity=50.0)
video_segment2 = VideoSegment(draft_id, track_name='video')
video_segment2.add_video_segment(
    material='../material/video2.mp4',
    target_timerange='6s-5s'
)
video_segment2.add_background_filling('blur', blur=0.5)
video_segment2.add_mask(
    mask_type='爱心',
    center_x=0.5,
    center_y=0.5,
    size=0.5,
    rotation=0.0,
    feather=0.0,
    invert=False,
    rect_width=0.5,
    round_corner=0.0
)
video_segment2.add_transition('闪黑', '1s')

video_segment3 = VideoSegment(draft_id, track_name='video')
video_segment3.add_video_segment(
    material='../material/video3.mp4',
    target_timerange='11s-5.20s'
)

# 创建文本片段
text_segment1 = TextSegment(
    draft_id=draft_id,
    track_name="text"
)
add_text_segment_params = text_segment1.add_text_segment(
    text="这是jianying-mcp制作的视频",
    timerange="0s-6s",
    clip_settings={"transform_y": -0.8}
)
text_segment1.add_animation('TextIntro', animation_name='向上滑动', duration='1s')
text_segment1.add_animation('TextOutro', animation_name='右上弹出', duration='1s')

text_segment2 = TextSegment(
    draft_id=draft_id,
    track_name="text"
)
text_segment2.add_text_segment(
    text="欢迎大家使用",
    timerange="6s-5s",
    clip_settings={"transform_y": -0.8}
)
text_segment3 = TextSegment(
    draft_id=draft_id,
    track_name="text"
)
text_segment3.add_text_segment(
    text="如果这个项目对你有帮助，请给个 Star 支持一下！",
    timerange="11s-5.20s",
    clip_settings={"transform_y": -0.8}
)
text_segment3.add_animation("TextLoopAnim", "色差故障")

ExportDraft().export(draft_id)
