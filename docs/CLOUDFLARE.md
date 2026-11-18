# Bản theo dõi (monitor) trên Cloudflare: dùng KV, không cần thẻ

Địa chỉ: **https://theme-check.pages.dev**. Mở trang, nhập **mã truy cập của team**, và xem tiến độ đang chạy theo từng theme, số liệu từng lần chạy, issue tracker (lỗi nào, theme nào, ngày nào, khi nào fix).

```text
Máy chạy check ──(tiến độ ~90 giây/lần, dữ liệu tổng hợp khi chạy xong)──▶ Cloudflare Pages Functions ──▶ KV (2 khóa: state, progress)
Team ──(mã truy cập)──▶ dashboard ───────────────────────────────────────────────────────────────────────┘

Ảnh / video / report.html ──▶ ở lại máy chạy (history/runs/...) ──▶ thư mục Google Drive để chia sẻ
```

## Cái gì ở đâu

| Thứ | Nằm ở | Ai xem được |
|---|---|---|
| Tiến độ, số liệu, issue tracker, danh sách theme | Cloudflare KV | Team, qua mã truy cập |
| Ảnh, video, `report.html` của từng lần chạy | Máy chạy check, thư mục `history/runs/<ngày>-<env>/` | Xem ngay trên máy chạy (`http://127.0.0.1:4173`, ảnh và video hiện thẳng trong trang). Cho team: chia sẻ qua Google Drive (xem dưới) |

Giới hạn của cách này: **team xem từ xa sẽ không thấy ảnh/video hiện trong trang**, chỉ thấy đường dẫn tới thư mục Drive.

## Chia sẻ ảnh/video qua Google Drive

1. Cài Google Drive cho máy tính (Drive for desktop) trên máy chạy check, đăng nhập tài khoản team.
2. Tạo một thư mục trong Drive, ví dụ `Theme_Check`, và chia sẻ cho team.
3. Trong `config/config.local.json` đặt lịch sử vào thư mục đó (Drive tự đồng bộ lên mạng):
   ```json
   "archive": { "dir": "G:\\My Drive\\Theme_Check", "keepVideosForRuns": 4 }
   ```
   (`G:` là ổ đĩa mà Drive for desktop tạo ra, có thể là chữ khác trên máy bạn.)
4. Lấy đường dẫn chia sẻ của thư mục đó trên Drive và đặt:
   ```json
   "evidence": { "driveUrl": "https://drive.google.com/drive/folders/..." }
   ```
   Trên dashboard của Cloudflare, mỗi lỗi sẽ có nút "Open the evidence on Drive" và đường dẫn con (`runs/<lần chạy>/<theme>/...`) để mở đúng ảnh/video.
5. Chạy `node src/cli.js sync` để cập nhật.

Lưu ý: Drive đồng bộ file có thể chậm với các file video lớn. Tool chỉ giữ video của 4 lần chạy gần nhất.

## Đã cài sẵn (làm ngày 2026-11-18)

- KV namespace `theme-check` (id nằm trong `wrangler.toml`).
- Project Pages `theme-check`, đã deploy dashboard và các Functions.
- Hai secret trên Cloudflare: `INGEST_TOKEN` (máy chạy dùng để đẩy dữ liệu) và `READ_KEY` (mã truy cập của team).
- `THEME_CHECK_TOKEN` (cùng giá trị `INGEST_TOKEN`) đã đặt trong biến môi trường Windows của bạn. Terminal mới mở sau đó mới thấy nó.
- Mã truy cập của team nằm trong `.secrets/team-access-code.txt` (file bị git bỏ qua). Gửi mã này cho người trong team qua kênh riêng, không đăng công khai.

## Dùng hằng ngày

- **Một lần chạy mới** tự đẩy tiến độ (khoảng 90 giây một lần) và đẩy dữ liệu tổng hợp khi xong, miễn là `THEME_CHECK_TOKEN` có trong môi trường của tiến trình chạy.
- **Đẩy tay:** `node src/cli.js sync`.
- **Một lần chạy đã bắt đầu mà chưa có cấu hình đẩy:** `node src/cli.js watch` đọc file tiến độ trên máy và đẩy lên, tự đẩy dữ liệu tổng hợp khi chạy xong.
- Đổi mã truy cập: `npx.cmd wrangler@3 pages secret put READ_KEY --project-name theme-check`, rồi nói với team mã mới.

## Giới hạn của gói miễn phí KV (xem lại giá/hạn mức hiện tại của Cloudflare)

- Khoảng 1.000 lần ghi mỗi ngày. Vì vậy tiến độ đẩy tối đa 90 giây một lần và không quá 900 lần một ngày; lần cập nhật cuối của một lần chạy luôn được gửi.
- KV có độ trễ: số liệu trên trang có thể chậm đến khoảng một phút so với thực tế.
- Mỗi giá trị tối đa 25 MiB (dữ liệu của chúng ta nhỏ hơn nhiều).

## Mức bảo vệ

- Không có mã truy cập thì `/api/state` và `/api/progress` trả 401, và cổng nhận dữ liệu từ máy chạy cũng từ chối khi thiếu `INGEST_TOKEN`. Đã kiểm tra trực tiếp trên địa chỉ thật.
- Mã truy cập là một mật khẩu dùng chung, không phải đăng nhập theo từng người. Ai có mã đều xem được. Khi có người rời team, đổi mã.
- Nếu sau này bạn chấp nhận đăng ký thẻ để dùng Cloudflare Access, có thể thêm đăng nhập bằng email của từng người ở phía trước. Khi đó cấu hình Service Token cho máy chạy (`CF_ACCESS_CLIENT_ID/SECRET`) vẫn được hỗ trợ.

## Cập nhật giao diện hoặc code Functions

```powershell
cd "C:\Users\BSS GROUP\Theme_Check"
node src/cli.js publish --dashboard-only
npx.cmd wrangler@3 pages deploy site --project-name theme-check --branch main
```

## Lỗi thường gặp

| Hiện tượng | Nguyên nhân |
|---|---|
| `Cannot reach the monitor: ... HTTP 401` | `THEME_CHECK_TOKEN` khác `INGEST_TOKEN` trên Cloudflare, hoặc terminal chưa nạp biến môi trường (mở terminal mới). |
| `THEME_CHECK_TOKEN is not set` | Tiến trình chạy trong cửa sổ mở trước khi đặt biến. Mở terminal mới, hoặc đăng xuất rồi đăng nhập lại Windows. |
| Dashboard hỏi mã nhiều lần | Mã nhập sai, hoặc trình duyệt đang chặn lưu dữ liệu trang (cửa sổ ẩn danh). |
| Tab Live trống nhưng máy đang chạy | Lần chạy đó không có cấu hình đẩy. Chạy `node src/cli.js watch`. |
| Tab Live báo STALLED | Hơn 10 phút không có cập nhật từ máy chạy: máy tắt, mất mạng, hoặc tiến trình chết. |

## Chưa làm

- Cảnh báo chủ động (email hoặc điện thoại) khi lần chạy bị dừng hay không có lần chạy nào.
- Ảnh/video hiện thẳng trong trang cho team từ xa (cần lưu trữ file, ví dụ R2, cần đăng ký thẻ).
