# Bản theo dõi trên Cloudflare (Pages + R2), đăng nhập bằng Google

Địa chỉ: **https://bss-theme-check.pages.dev**. Bấm **Sign in with Google** bằng tài khoản công ty **@bsscommerce.com**. Tài khoản khác (Gmail cá nhân, tên miền khác) bị từ chối. Sau khi vào, bạn xem tiến độ đang chạy theo từng theme, số liệu từng lần chạy, issue tracker, báo cáo và **ảnh chụp màn hình tại khoảnh khắc lỗi**. Không có video.

```text
Máy chạy check ──(tiến độ ~30 giây/lần; kết quả, báo cáo, ảnh khi chạy xong)──▶ Pages Functions ──▶ R2 (một bucket)
Team ──(Sign in with Google, chỉ @bsscommerce.com)──▶ dashboard ──────────────────────────────────────┘
```

## Cái gì ở đâu

| Thứ | Nằm ở |
|---|---|
| Tiến độ, số liệu, issue tracker, danh sách theme | R2: `data/state.json`, `data/progress.json` |
| `report.html`, `summary.json`, `results.json` và ảnh chụp lỗi của từng lần chạy | R2: `runs/<ngày>-<env>/...` |
| Cùng các file trên | Máy chạy check: `history/runs/...` (xem ngay ở `http://127.0.0.1:4173`) |

Ảnh của check đã pass bị xóa sau mỗi lần chạy, chỉ giữ ảnh của check lỗi hoặc cần xem tay.

## Tài khoản và tên

Tất cả nằm trên tài khoản Cloudflare **`dungnn@bsscommerce.com`** (Account ID `929260e1f561ff749ec1a5ceacd62255`): project Pages `bss-theme-check`, bucket R2 `theme-check-data`. Đăng nhập Google dùng dự án Google Cloud **`theme-check`** (tổ chức bsscommerce.com), màn hình đồng ý OAuth ở chế độ **Internal**, OAuth client kiểu Web tên "Theme Check web", nguồn JavaScript `https://bss-theme-check.pages.dev`. (Một bản thử cũ tên `theme-check` còn ở tài khoản Cloudflare RMIT, không dùng nữa.)

## Đăng nhập hoạt động thế nào (và vì sao chỉ @bsscommerce.com)

Có **ba lớp** chặn tài khoản ngoài công ty:

1. **Google:** màn hình đồng ý ở chế độ *Internal* chỉ cho tài khoản trong tổ chức bsscommerce.com đăng nhập vào ứng dụng này.
2. **Máy chủ kiểm tra lại** thẻ đăng nhập Google (ID token) mỗi lần: chữ ký của Google, đúng ứng dụng của chúng ta (`aud`), chưa hết hạn, email đã xác minh, địa chỉ kết thúc bằng `@bsscommerce.com` **và** claim `hd` (Google Workspace) bằng `bsscommerce.com`.
3. **Phiên đăng nhập:** cookie ký bằng `SESSION_SECRET` (HttpOnly, Secure, hết hạn sau 12 giờ), và đuôi email được kiểm tra lại ở **mỗi** yêu cầu xem dữ liệu, ảnh hay báo cáo.

Các trường hợp bị chặn đều có test tự động: Gmail cá nhân, `hd` giả, tên miền giống như `evilbsscommerce.com`, `bsscommerce.com.evil.com`, email chưa xác minh, thẻ của ứng dụng khác, thẻ hết hạn, ký bằng khóa khác, `alg: none`, sửa nội dung sau khi ký, cookie giả, cookie hết hạn.

Không còn mã truy cập chung. Mã cũ (`READ_KEY`) đã bị xóa khỏi Cloudflare, nên không còn đường vào nào bỏ qua kiểm tra đuôi email.

## Cài đặt (đã làm xong, ghi lại để biết)

1. Bật R2 trên Cloudflare, `npx.cmd wrangler@3 r2 bucket create theme-check-data`.
2. `npx.cmd wrangler@3 pages project create bss-theme-check --production-branch main`.
3. Secret trên Pages: `INGEST_TOKEN` (cho máy chạy check), `SESSION_SECRET` (ký cookie). Cả hai là chuỗi ngẫu nhiên, chỉ nằm trên Cloudflare.
4. Biến công khai trong `wrangler.toml`: `ALLOWED_DOMAIN = "bsscommerce.com"` và `GOOGLE_CLIENT_ID` (Client ID của OAuth client; đây không phải mật khẩu). Client secret của Google **không dùng và không lưu ở đâu**.
5. `node src/cli.js publish --dashboard-only`, rồi `npx.cmd wrangler@3 pages deploy site --project-name bss-theme-check --branch main`. Hoặc để GitHub tự deploy (xem `docs/GITHUB.md`).
6. Máy chạy check: biến môi trường Windows `THEME_CHECK_TOKEN` (cùng giá trị `INGEST_TOKEN`) và trong `config/config.local.json` có `"cloudflare": { "url": "https://bss-theme-check.pages.dev" }`.

Thử: `node src/cli.js sync --all` (đẩy dữ liệu và ảnh của mọi lần chạy hiện có).

## Dùng hằng ngày

- Một lần chạy mới tự đẩy tiến độ (khoảng 30 giây một lần) và đẩy kết quả cùng ảnh khi xong.
- Đẩy tay: `node src/cli.js sync --all` (hoặc `--run <mã>`).
- Một lần chạy đã bắt đầu mà không có cấu hình đẩy: `node src/cli.js watch`.
- Ai trong công ty cũng vào được bằng tài khoản Google của mình. Người rời công ty mất tài khoản thì mất quyền xem sau khi phiên cũ hết hạn (tối đa 12 giờ). Muốn cắt ngay: đổi `SESSION_SECRET`.
- Đổi `SESSION_SECRET` (làm mọi người đăng nhập lại): `npx.cmd wrangler@3 pages secret put SESSION_SECRET --project-name bss-theme-check` với một chuỗi ngẫu nhiên mới, rồi deploy lại.

## Sửa lịch chạy / danh sách theme ngay trên web

- Chỉ email trong biến `EDITORS` (wrangler.toml, hiện `dungnn@bsscommerce.com`, ngăn cách bằng dấu phẩy) mới lưu được; người khác trong công ty chỉ xem.
- Bấm Save trên web: Cloudflare giữ cấu hình (có số thứ tự `rev`); **agent** trên máy chạy (`node src/cli.js agent --install`, kiểm tra mỗi phút) kiểm tra lại, ghi `config/schedule.json` / `themes.json`, cập nhật Windows Task Scheduler, commit + push lên GitHub, rồi báo từng bước về trang.
- Lưu trên dashboard cục bộ thì làm cùng chuỗi bước đó ngay lập tức.
- Mọi giờ hiển thị theo UTC+7.

## Lỗi thường gặp

| Hiện tượng | Nguyên nhân |
|---|---|
| "Only @bsscommerce.com accounts can sign in." | Đăng nhập bằng tài khoản Google không thuộc bsscommerce.com. Chọn đúng tài khoản công ty. |
| "Google sign-in could not be verified." | Đồng hồ máy lệch, thẻ hết hạn, hoặc Client ID không khớp. Tải lại trang và thử lại. |
| "Sign-in is not configured yet." | `GOOGLE_CLIENT_ID` hoặc `SESSION_SECRET` chưa có ở bản deploy hiện tại. |
| Nút Google không hiện | Trình duyệt hoặc tiện ích chặn `accounts.google.com`. Tắt tiện ích chặn quảng cáo cho trang này. |
| Google báo "Error 400: origin_mismatch" | Nguồn JavaScript của OAuth client chưa đúng `https://bss-theme-check.pages.dev`. Sửa ở Google Cloud > Google Auth Platform > Clients (có thể mất vài phút để có hiệu lực). |
| `Cannot reach the monitor: ... HTTP 401` (khi `sync`) | `THEME_CHECK_TOKEN` khác `INGEST_TOKEN`, hoặc terminal chưa nạp biến môi trường (mở terminal mới). |
| `THEME_CHECK_TOKEN is not set` | Tiến trình chạy trong cửa sổ mở trước khi đặt biến. Mở terminal mới. |
| Tab Live trống nhưng máy đang chạy | Lần chạy đó không có cấu hình đẩy. Chạy `node src/cli.js watch`. |
| Tab Live báo STALLED | Hơn 10 phút không có cập nhật từ máy chạy: máy tắt, mất mạng, hoặc tiến trình chết. |
| Ảnh không hiện trên Cloudflare | Chạy `node src/cli.js sync --run <mã>` để đẩy ảnh của lần chạy đó. |

## Chưa làm

- Cảnh báo chủ động (email hoặc điện thoại) khi lần chạy bị dừng hay không có lần chạy nào.
- Giới hạn theo nhóm hoặc từng người trong công ty (hiện ai có tài khoản bsscommerce.com đều xem được).
