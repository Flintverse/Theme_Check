# Triển khai bản theo dõi (monitor) lên Cloudflare

Mục tiêu: mở một địa chỉ web (ví dụ `https://theme-check.pages.dev`), đăng nhập bằng email của team, và xem **tiến độ đang chạy theo từng theme, kết quả, lịch sử, issue tracker, báo cáo, ảnh, video**, từ bất kỳ đâu.

Việc **chạy check** vẫn nằm trên máy Windows của bạn (cần Chrome đã đăng nhập Shopify). Cloudflare chỉ **nhận dữ liệu từ máy đó và hiển thị**. Xem lý do ở [DEPLOYMENT.md](DEPLOYMENT.md).

```text
Máy chạy check  ──(đẩy tiến độ mỗi ~8 giây, đẩy kết quả khi xong)──▶  Cloudflare Pages Functions  ──▶  R2 (lưu dữ liệu, ảnh, video)
                                                                          ▲
Bạn / team  ──(đăng nhập qua Cloudflare Access)──▶ dashboard  ───────────┘
```

Chi phí: gói miễn phí của Cloudflare đủ cho mức dùng này (Pages, Access tối đa 50 người, R2 10 GB). R2 và Zero Trust có thể yêu cầu thêm phương thức thanh toán khi bật. Giá và giới hạn có thể thay đổi, hãy kiểm tra lại trên trang giá của Cloudflare.

Giao diện Cloudflare đổi thường xuyên, nên tên nút dưới đây có thể lệch chút. Các lệnh thì chính xác.

---

## Bước 0. Chuẩn bị

- Một tài khoản Cloudflare (đăng ký miễn phí tại dash.cloudflare.com).
- Máy chạy check đã có `npm install` trong thư mục `Theme_Check`.

## Bước 1. Đăng nhập wrangler (công cụ dòng lệnh của Cloudflare)

```powershell
cd "C:\Users\BSS GROUP\Theme_Check"
npx wrangler login
```

Trình duyệt mở ra, bạn bấm cho phép. Kiểm tra: `npx wrangler whoami` hiện email của bạn.

## Bước 2. Tạo kho lưu trữ R2

```powershell
npx wrangler r2 bucket create theme-check-data
```

Nếu báo cần bật R2, vào dash.cloudflare.com > R2 và bật (có thể hỏi thông tin thanh toán, dùng trong hạn mức miễn phí thì không bị tính tiền). Tên bucket `theme-check-data` khớp với file `wrangler.toml`. Đổi tên thì sửa cả hai nơi.

## Bước 3. Tạo dự án Pages

```powershell
npx wrangler pages project create theme-check --production-branch main
```

Địa chỉ sẽ là `https://theme-check.pages.dev` (nếu tên đã bị người khác dùng, đặt tên khác và dùng tên đó ở các bước sau).

## Bước 4. Tạo mật khẩu cho máy chạy check (INGEST_TOKEN)

Đây là chìa khóa để máy của bạn được phép đẩy dữ liệu lên. Tạo một chuỗi ngẫu nhiên dài:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy chuỗi đó (gọi là `TOKEN`). Đặt nó vào Cloudflare như một secret:

```powershell
npx wrangler pages secret put INGEST_TOKEN --project-name theme-check
```

Dán `TOKEN` khi được hỏi. **Không** ghi `TOKEN` vào bất kỳ file nào trong repo, không gửi qua chat.

## Bước 5. Đưa bản dashboard lên

```powershell
node src/cli.js publish --dashboard-only
npx wrangler pages deploy site --project-name theme-check
```

Lệnh thứ hai đọc `wrangler.toml` và thư mục `functions/` ở thư mục gốc. Sau khi xong sẽ in địa chỉ `https://....pages.dev`.

Kiểm tra liên kết với R2: vào dash.cloudflare.com > Workers & Pages > theme-check > Settings > Bindings (hoặc Functions). Phải có R2 bucket, tên biến `STORE`, bucket `theme-check-data`. Nếu thiếu thì thêm bằng tay, rồi chạy lại lệnh deploy.

Lúc này địa chỉ **chưa được bảo vệ**: ai biết link đều xem được. Làm ngay bước 6.

## Bước 6. Bảo vệ bằng Cloudflare Access (bắt buộc)

Báo cáo có ảnh màn hình admin và các lỗi của app, không nên để công khai.

1. Vào one.dash.cloudflare.com (Zero Trust). Lần đầu sẽ hỏi tên team và gói, chọn gói Free.
2. Access > Applications > Add an application > Self-hosted.
3. Domain: `theme-check.pages.dev`. Thêm một domain nữa: `*.theme-check.pages.dev` (chặn cả các bản preview mà Pages tự tạo).
4. Tạo hai policy:
   - **Policy "Team"**: Action = Allow, Include = Emails, điền email của từng người trong team.
   - **Policy "Runner"**: Action = Service Auth, Include = Service Token (tạo ở bước 7).
5. Lưu.

## Bước 7. Tạo Service Token cho máy chạy check

Máy chạy check không đăng nhập bằng email được, nên dùng token:

1. Zero Trust > Access > Service Auth > Service Tokens > Create Service Token, tên `theme-check-runner`.
2. Cloudflare hiện **Client ID** và **Client Secret**. Secret chỉ hiện **một lần**, hãy copy ngay.
3. Quay lại policy "Runner" ở bước 6 và chọn token này.

## Bước 8. Cấu hình máy chạy check

1. Trong `config/config.local.json` thêm (đúng địa chỉ của bạn):

   ```json
   "cloudflare": { "url": "https://theme-check.pages.dev", "uploadVideos": false }
   ```

   `uploadVideos: false` để chỉ đẩy ảnh và báo cáo (video lớn, tốn dung lượng). Đổi thành `true` nếu muốn xem video từ xa.

2. Đặt 3 biến môi trường Windows (chạy trong PowerShell, thay giá trị thật, rồi **mở lại** cửa sổ terminal):

   ```powershell
   setx THEME_CHECK_TOKEN "TOKEN_Ở_BƯỚC_4"
   setx CF_ACCESS_CLIENT_ID "CLIENT_ID_Ở_BƯỚC_7"
   setx CF_ACCESS_CLIENT_SECRET "CLIENT_SECRET_Ở_BƯỚC_7"
   ```

   Các biến này nằm trong hồ sơ người dùng Windows, không nằm trong repo. Task Scheduler chạy dưới tài khoản của bạn nên cũng đọc được chúng.

## Bước 9. Thử

```powershell
node src/cli.js sync --all
```

Kết quả mong đợi: `Monitor updated: dashboard data, N run(s), M file(s).`

Mở `https://theme-check.pages.dev`: Cloudflare Access yêu cầu email, nhập email của bạn, nhận mã, rồi vào dashboard. Thấy các lần chạy trước và có thể mở báo cáo.

Lỗi thường gặp:

| Hiện tượng | Nguyên nhân |
|---|---|
| `Cannot reach the monitor: ... HTTP 401` | `THEME_CHECK_TOKEN` khác với `INGEST_TOKEN` trên Cloudflare. |
| `HTTP 403` hoặc trả về trang đăng nhập | Thiếu hoặc sai `CF_ACCESS_CLIENT_ID/SECRET`, hoặc policy "Runner" chưa gắn token. |
| `HTTP 500` và `STORE ... missing` | Chưa gắn R2 bucket với tên biến `STORE` (bước 5). |
| Dashboard trống | Chưa có lần đẩy nào. Chạy `sync --all`. |

## Bước 10. Theo dõi một lần chạy

Khi một lần chạy bắt đầu (từ nút Run now, từ Task Scheduler, hoặc `node src/cli.js run ...`), máy chạy check tự đẩy tiến độ lên Cloudflare mỗi khoảng 8 giây. Mở dashboard trên Cloudflare, tab **Live**:

- thanh tiến độ (số theme đã xong, ước tính còn bao lâu);
- theme đang làm và bước đang làm (ví dụ "Checking the horizontal layout (desktop)");
- bảng từng theme: xếp hàng, đang cài, đang thiết lập, đang test, xong, hoặc không thiết lập được, kèm số lỗi tìm được cho tới lúc này;
- các sự kiện gần nhất.

Nếu máy tắt hoặc mất mạng giữa chừng, sau 10 phút không có cập nhật, tab Live hiện **STALLED**.

Khi lần chạy kết thúc, máy chạy check tự đẩy dữ liệu tổng hợp, issue tracker, báo cáo và ảnh (và video nếu bật). Nếu bước này lỗi, chạy tay: `node src/cli.js sync --run <mã-lần-chạy>`.

## Cập nhật sau này

- Sửa giao diện hoặc code Functions: `node src/cli.js publish --dashboard-only` rồi `npx wrangler pages deploy site --project-name theme-check`.
- Dữ liệu (kết quả, ảnh) không cần deploy lại: tự đẩy sau mỗi lần chạy.
- Thay đổi danh sách theme và lịch chạy vẫn làm trên máy chạy check (bản trên Cloudflare chỉ để xem).

## Những gì chưa làm

- Cảnh báo chủ động (email hoặc điện thoại) khi lần chạy bị dừng hoặc không có lần chạy nào. Hiện chỉ có chỉ báo STALLED khi bạn mở trang.
- Chưa thử với tài khoản Cloudflare thật: logic của các Functions đã test bằng một R2 giả trong test tự động, nhưng lần deploy đầu tiên cần bạn chạy các bước trên, và có thể phải chỉnh nhỏ theo thông báo lỗi thật.
