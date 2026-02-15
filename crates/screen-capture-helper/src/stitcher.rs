use image::RgbaImage;

/// 长截图拼接器
pub struct Stitcher {
    frames: Vec<RgbaImage>,
    overlap_ratio: f32,  // 用于检测重叠的比例 (0.2 = 20%)
}

impl Stitcher {
    pub fn new() -> Self {
        Self {
            frames: Vec::new(),
            overlap_ratio: 0.2,
        }
    }

    /// 添加一帧
    pub fn push_frame(&mut self, frame: RgbaImage) {
        self.frames.push(frame);
    }

    /// 帧数
    pub fn frame_count(&self) -> usize {
        self.frames.len()
    }

    /// 检查最后两帧是否几乎相同 (到底部了)
    pub fn is_at_bottom(&self) -> bool {
        if self.frames.len() < 2 {
            return false;
        }
        let last = &self.frames[self.frames.len() - 1];
        let prev = &self.frames[self.frames.len() - 2];
        frame_similarity(prev, last) > 0.99
    }

    /// 拼接所有帧，返回最终长图
    pub fn stitch(&self) -> Result<RgbaImage, String> {
        if self.frames.is_empty() {
            return Err("没有帧可拼接".to_string());
        }
        if self.frames.len() == 1 {
            return Ok(self.frames[0].clone());
        }

        let width = self.frames[0].width();
        let mut segments: Vec<&RgbaImage> = Vec::new();
        let mut offsets: Vec<u32> = Vec::new(); // 每帧在最终图中的 y 偏移 (去重叠后)

        segments.push(&self.frames[0]);
        offsets.push(0);
        let mut total_height = self.frames[0].height();

        for i in 1..self.frames.len() {
            let prev = &self.frames[i - 1];
            let curr = &self.frames[i];

            // 检测重叠行数
            let overlap = find_overlap(prev, curr, self.overlap_ratio);

            if overlap > 0 && overlap < curr.height() {
                let unique_height = curr.height() - overlap;
                offsets.push(total_height);
                total_height += unique_height;
            } else {
                // 没有检测到重叠，直接追加
                offsets.push(total_height);
                total_height += curr.height();
            }
            segments.push(curr);
        }

        // 创建最终大图
        let mut result = RgbaImage::new(width, total_height);

        // 第一帧完整复制
        image::imageops::overlay(&mut result, segments[0], 0, 0);

        // 后续帧只复制非重叠部分
        for i in 1..segments.len() {
            let prev = &self.frames[i - 1];
            let curr = segments[i];
            let overlap = find_overlap(prev, curr, self.overlap_ratio);
            let y_start = overlap; // 跳过重叠部分
            let y_offset = offsets[i] as i64;

            // 逐行复制非重叠部分
            for y in y_start..curr.height() {
                for x in 0..curr.width().min(width) {
                    let pixel = curr.get_pixel(x, y);
                    let target_y = y_offset + (y - y_start) as i64;
                    if target_y >= 0 && (target_y as u32) < total_height {
                        result.put_pixel(x, target_y as u32, *pixel);
                    }
                }
            }
        }

        Ok(result)
    }
}

/// 查找两帧之间的重叠行数
/// 取 prev 底部 overlap_ratio 高度的行，在 curr 顶部搜索最佳匹配位置
fn find_overlap(prev: &RgbaImage, curr: &RgbaImage, overlap_ratio: f32) -> u32 {
    let h = prev.height();
    let template_height = (h as f32 * overlap_ratio) as u32;
    if template_height < 10 {
        return 0;
    }

    let search_range = (h as f32 * 0.4) as u32; // 在新帧顶部 40% 范围内搜索
    let width = prev.width().min(curr.width());

    // 采样列 (每隔 step 列取一个，加速计算)
    let step = (width / 50).max(1);

    let mut best_offset = 0u32;
    let mut best_mse = f64::MAX;

    // template = prev 底部 template_height 行
    // 在 curr 顶部滑动匹配
    for offset in 0..search_range.min(curr.height()) {
        let mut mse = 0.0;
        let mut count = 0u64;

        for ty in 0..template_height.min(curr.height().saturating_sub(offset)) {
            let prev_y = h - template_height + ty;
            let curr_y = offset + ty;
            if curr_y >= curr.height() {
                break;
            }

            let mut x = 0;
            while x < width {
                let pp = prev.get_pixel(x, prev_y);
                let cp = curr.get_pixel(x, curr_y);
                let dr = pp[0] as f64 - cp[0] as f64;
                let dg = pp[1] as f64 - cp[1] as f64;
                let db = pp[2] as f64 - cp[2] as f64;
                mse += dr * dr + dg * dg + db * db;
                count += 1;
                x += step;
            }
        }

        if count > 0 {
            let avg_mse = mse / count as f64;
            if avg_mse < best_mse {
                best_mse = avg_mse;
                best_offset = offset;
            }
        }
    }

    // 如果最佳 MSE 足够小，认为找到了重叠
    // 阈值: 每通道平均误差 < 15 (即 sqrt(mse/3) < 15 → mse < 675)
    if best_mse < 675.0 {
        // 重叠行数 = template_height - best_offset
        // best_offset 是 curr 中匹配位置，0 表示完全对齐
        template_height.saturating_sub(best_offset)
    } else {
        0
    }
}

/// 计算两帧的整体相似度 (0.0 ~ 1.0)
fn frame_similarity(a: &RgbaImage, b: &RgbaImage) -> f64 {
    let width = a.width().min(b.width());
    let height = a.height().min(b.height());
    if width == 0 || height == 0 {
        return 0.0;
    }

    let step_x = (width / 100).max(1);
    let step_y = (height / 100).max(1);
    let mut same = 0u64;
    let mut total = 0u64;

    let mut y = 0;
    while y < height {
        let mut x = 0;
        while x < width {
            let pa = a.get_pixel(x, y);
            let pb = b.get_pixel(x, y);
            let diff = (pa[0] as i32 - pb[0] as i32).abs()
                + (pa[1] as i32 - pb[1] as i32).abs()
                + (pa[2] as i32 - pb[2] as i32).abs();
            if diff < 30 {
                same += 1;
            }
            total += 1;
            x += step_x;
        }
        y += step_y;
    }

    same as f64 / total as f64
}
