# -*- coding: utf-8 -*-
"""
Author: jian wei
File Name: effect_manager.py
"""
import logging
from typing import List, Any, Optional, Dict
import difflib
from pyJianYingDraft import VideoSceneEffectType, TextIntro, TextOutro, TextLoopAnim, IntroType, OutroType, GroupAnimationType, VideoCharacterEffectType
from pyJianYingDraft.metadata.audio_effect_meta import ToneEffectType, AudioSceneEffectType, SpeechToSongType
from pyJianYingDraft.metadata.filter_meta import FilterType
from pyJianYingDraft.metadata.mask_meta import MaskType
from pyJianYingDraft.metadata.transition_meta import TransitionType
from pyJianYingDraft.metadata.font_meta import FontType


class JianYingResourceManager:
    """
    剪映资源管理器

    提供获取各种特效、字体、滤镜等资源的统一接口
    """

    # 特效类型映射 - 共15个特效类型
    EFFECT_TYPE_MAPPING = {
        "VIDEO_SCENE": VideoSceneEffectType,  # 画面特效类型
        "ToneEffectType": ToneEffectType,  # 音频音色
        "AudioSceneEffectType": AudioSceneEffectType,  # 音频场景
        "filter_type": FilterType,  # 滤镜
        "SpeechToSongType": SpeechToSongType,  # 语音转歌曲
        "mask_type": MaskType,  # 蒙版
        "TransitionType": TransitionType,  # 转场
        "Font": FontType,  # 字体
        "TextIntro": TextIntro,  # 文字入场
        "TextOutro": TextOutro,  # 文字出场
        "TextLoopAnim": TextLoopAnim,  # 文字循环动画
        "GroupAnimationType": GroupAnimationType,  # 组合动画
        "VIDEO_CHARACTER": VideoCharacterEffectType,  # 视频人物特效
        "IntroType": IntroType,  # 视频/图片入场动画类型
        "OutroType": OutroType  # 视频/图片出场动画类型
    }

    DESCRIPTIONS = {
        "VIDEO_SCENE": "视频画面特效，包含各种视觉效果和场景特效",
        "ToneEffectType": "音频音色特效，用于改变声音的音调和音色",
        "AudioSceneEffectType": "音频场景特效，提供各种环境音效和声音处理",
        "filter_type": "滤镜特效，用于调整画面色彩和风格",
        "SpeechToSongType": "语音转歌曲特效",
        "mask_type": "蒙版特效",
        "TransitionType": "转场特效",
        "Font": "字体特效",
        "TextIntro": "文字入场特效",
        "TextOutro": "文字出场特效",
        "TextLoopAnim": "文字循环动画特效",
        "GroupAnimationType": "组合动画特效",
        "VIDEO_CHARACTER": "视频人物特效",
        "IntroType": "视频/图片入场动画类型",
        "OutroType": "视频/图片出场动画类型"
    }

    def __init__(self):
        """初始化资源管理器"""
        pass

    def get_all_types(self) -> Dict[str, str]:
        """
        获取所有的资源类型列表

        Returns:
            Dict[str, str]: 包含所有资源类型及其描述的字典
        """
        return self.DESCRIPTIONS.copy()

    def find_by_type(self, effect_type: str, is_vip: Optional[bool] = None, limit: int = None, keyword: str = None) -> List[Dict[str, Any]]:
        """
        根据类型获取特效资源

        Args:
            effect_type (str): 特效类型，支持的类型见 EFFECT_TYPE_MAPPING
            is_vip (Optional[bool]): 是否只获取VIP资源，None表示获取所有
            limit(int)：返回数量，默认为None,即全部返回，有的特效数量比较多，建议加上
            keyword (str): 模糊匹配关键词，用于搜索特效名称，None表示不过滤

        Returns:
            List[Dict[str, Any]]: 特效数据字典列表，每个字典包含原始特效对象的所有属性（除了md5）

        Raises:
            ValueError: 当特效类型参数无效时抛出异常
        """
        try:

            if not effect_type:
                raise ValueError("没有指定资源类型")

            if effect_type not in self.EFFECT_TYPE_MAPPING:
                raise ValueError(f"无效的特效类型。支持的类型: {list(self.EFFECT_TYPE_MAPPING.keys())}")

            enum_class = self.EFFECT_TYPE_MAPPING[effect_type]
            result = self._extract_effects_from_enum(enum_class, is_vip)

            # 模糊匹配过滤
            if keyword:
                result = self._fuzzy_match_filter(result, keyword)

            if limit:
                result = result[:limit]
            return result

        except ValueError as ve:
            raise ve
        except Exception as e:
            raise Exception(f"获取特效数据失败: {str(e)}")

    def _extract_effects_from_enum(self, enum_class, is_vip: Optional[bool] = None) -> List[Dict[str, Any]]:
        """
        从枚举类中提取特效数据，返回原始特效对象的所有属性（除了md5）

        Args:
            enum_class: 特效枚举类
            is_vip (Optional[bool]): VIP过滤条件

        Returns:
            List[Dict[str, Any]]: 特效数据字典列表，包含原始对象的所有属性
        """
        result = []

        for effect_enum_member in enum_class:
            effect_meta = effect_enum_member.value

            # 创建数据字典，包含所有属性（除了md5）
            effect_data = {}

            # 获取所有属性，排除私有属性和md5
            for attr_name in dir(effect_meta):
                if attr_name.startswith('_') or attr_name == 'md5':
                    continue

                try:
                    attr_value = getattr(effect_meta, attr_name)

                    # 跳过方法和函数
                    if callable(attr_value):
                        continue

                    # 特殊处理时长字段（微秒转秒）
                    if attr_name == 'duration' and isinstance(attr_value, int) and attr_value > 1000000:
                        effect_data[attr_name] = attr_value / 1000000.0
                    # 跳过params参数
                    elif attr_name == 'params':
                        continue
                    else:
                        effect_data[attr_name] = attr_value

                except:
                    # 如果获取属性失败，跳过
                    continue

            # VIP过滤
            effect_is_vip = effect_data.get('is_vip', False)
            if is_vip is not None and effect_is_vip != is_vip:
                continue

            if effect_data:  # 确保有数据才添加
                result.append(effect_data)

        return result

    def _fuzzy_match_filter(self, effects: List[Dict[str, Any]], keyword: str) -> List[Dict[str, Any]]:
        """
        智能模糊匹配过滤，使用文本相似度算法

        支持多种匹配模式：
        1. 完全匹配 - 最高优先级
        2. 开头匹配 - 高优先级
        3. 包含匹配 - 中等优先级
        4. 文本相似度匹配 - 使用difflib或rapidfuzz
        5. 字符序列匹配 - 支持部分字符匹配

        Args:
            effects: 特效列表
            keyword: 搜索关键词

        Returns:
            List[Dict[str, Any]]: 按相似度排序的匹配特效列表
        """
        if not keyword:
            return effects

        scored_results = []

        for effect in effects:
            # 获取特效名称
            effect_name = ""
            if 'name' in effect and effect['name']:
                effect_name = str(effect['name'])
            elif 'title' in effect and effect['title']:
                effect_name = str(effect['title'])

            if not effect_name:
                continue

            # 计算匹配得分
            match_score = self._calculate_similarity_score(keyword, effect_name)

            # 只保留有一定相似度的结果
            if match_score >= 30:  # 相似度阈值30%
                effect_copy = effect.copy()
                effect_copy['_match_score'] = match_score
                scored_results.append(effect_copy)

        # 按匹配得分排序，得分高的在前
        scored_results.sort(key=lambda x: x.get('_match_score', 0), reverse=True)

        # 移除临时的匹配得分字段
        for effect in scored_results:
            if '_match_score' in effect:
                del effect['_match_score']

        return scored_results

    def _calculate_similarity_score(self, keyword: str, effect_name: str) -> float:
        """计算文本相似度得分"""
        if keyword == effect_name:
            return 100.0
        if keyword in effect_name:
            return 90.0
        score = difflib.SequenceMatcher(None, keyword, effect_name).ratio() * 100
        return score if score >= 30 else 0.0




if __name__ == "__main__":
    manager = JianYingResourceManager()
    results = manager.find_by_type("TextLoopAnim", keyword="色差故障", limit=3)
    for i in results:
        print(i)

