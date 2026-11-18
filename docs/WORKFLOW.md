# Theme check: workflow + checklist cuối cùng (bản nháp để duyệt)

Nguồn: Google Doc "Guide tool check theme" + Sheet "Findter List tương thích theme (Final)" (tab "Theme cần tương thích" Round 1/2 và tab "Theme đã tương thích", khoảng 58 theme) + tool `tools/theme-canary/` hiện có.
Con số "~N theme" bên dưới là số theme có ghi lỗi đó trong sheet (đếm gần đúng bằng từ khóa).

## A. Workflow mỗi tuần (theo lô)

1. **Chuẩn bị môi trường:** chọn Staging (staging store, app SNF Staging) hoặc Prod (prod store, app Findter Filter & Search). Đăng nhập bằng profile đã lưu, không lưu mật khẩu trong file.
2. **Dọn store:** xóa hết theme cũ (giới hạn 20 theme/account).
3. **Cài lô 10 theme** từ list (Try theme, chờ ~3 phút cho mỗi theme cài xong, xác nhận theme có trong account).
4. **Với từng theme trong lô** (3 tab cùng lúc; **thứ tự bắt buộc: Tab 1, Tab 2, rồi mới có Tab 3**):
   - **Tab 1 (admin):** Filter and grid design, chọn Filter layout = Vertical, Save.
   - **Tab 2 (theme editor):** Collections > Default Collection, App embeds, bật "Search & filter core", chờ 10s, bật "Search suggestion", chờ 20s.
     - Check panel "Compatibility issue detected" (xem mục B0).
     - Mở block core, chọn theme trong Theme list, chờ 10-15s, Save, xác nhận Save đã bấm.
     - **Mở Tab 3:** sau khi đã vào theme editor, bật đủ embed và Save, bấm icon "..." trên headnav của theme editor rồi chọn **Preview**. Tab mới hiện ra chính là **Tab 3**.
   - **Tab 3 (storefront preview, tab test chính):** KHÔNG dùng URL `myshopify.com` trực tiếp, vì theme paid (đang Try) không publish nên không xem được bằng URL đó. Chỉ dùng tab Preview từ Tab 2. Trong tab này vào Catalog (`/collections/all`) và chạy checklist theo từng layout: Vertical (desktop), Horizontal (desktop), Off-canvas (desktop), Mobile (off-canvas), Search desktop, Search mobile.
   - **Mỗi lần đổi layout:** vào Tab 1 chọn layout mới, Save, **quay lại Tab 3 và reload** để áp dụng layout mới (không reload thì vẫn thấy layout cũ).
   - **Kết thúc mỗi theme (trước khi sang theme kế):**
     1. Tab 1: chọn lại **Vertical**, Save.
     2. Tab 2: bấm **icon Exit** (icon ngoài cùng, góc trên bên trái của theme editor) để thoát ra ngoài, rồi chọn **Edit theme** của theme tiếp theo trong lô.
     3. Quay lại bước đầu cho theme mới (bật embed, chọn theme trong Theme list, Save, Preview để có Tab 3 mới).
5. **Chụp ảnh đầy đủ mỗi bước, quay video tại chỗ phát hiện lỗi** (video cho các lỗi tương tác: hover, mở drawer, search).
6. **Hết lô 10 theme:** xóa 10 theme vừa test, cài lô 10 theme tiếp theo, lặp lại đến hết list.
7. **Sinh báo cáo + gửi Gmail:** run sheet kiểu "Watermark Self-test 885" (một thẻ cho mỗi mục checklist: Steps, Expected, Actual theo từng theme, evidence ảnh + video; mục fail lên đầu; tổng pass/fail/blocked/manual). So với tuần trước: NEW / STILL / FIXED. Nhóm các theme có cùng lỗi.

Lưu ý quy trình: Prod có thể chưa có bản fix, Staging để test bản vá mới nhất. Nên chạy cả hai và ghi rõ môi trường trong báo cáo.

## B. Checklist (ID, cách kiểm, kỳ vọng, mức độ)

Severity: C = critical (khách không lọc/tìm được), M = major (lỗi nhìn thấy rõ), m = minor (chỉnh sửa nhỏ).

### B0. Panel "Compatibility issue detected" (sau khi bật embed, trước khi chọn theme)
| ID | Kiểm tra | Kỳ vọng | Sev |
|---|---|---|---|
| P-01 | Nút X của panel | Có hiển thị, đúng size, cùng dòng với "Compatibility issue detected", không lệch trên/dưới/trái/phải, không to bất thường, không biến thành icon vuông | M |
| P-02 | Sau khi chọn theme và Save | Panel tự tắt | m |

### B1. Vertical (desktop), áp dụng lại y hệt cho Horizontal và Off-canvas
| ID | Kiểm tra | Kỳ vọng | Sev | Tần suất trong sheet |
|---|---|---|---|---|
| V-01 | Ô "Search in this collection" và "Search filter value": icon kính lúp + placeholder | Icon hiện đủ (không bị crop/bôi đậm/mất cạnh trái-phải), không dính placeholder, placeholder hiện đủ chữ | M | ~11 theme |
| V-02 | Filter value và count trong mỗi box | Cùng một dòng, thẳng hàng, không lệch lên/xuống | M | ~5 |
| V-03 | Hover vào filter value | Màu count khác nền hover, vẫn đọc được (không biến mất vì cùng màu đen) | M | ~34 (phổ biến nhất) |
| V-04 | Price slider | 2 chấm tròn nằm đúng tâm đường slider | m | |
| V-05 | Merge value group | Có icon mũi tên expand/collapse nhìn thấy, bấm expand/collapse thật; checkbox + tên group + mũi tên cùng một dòng; khoảng cách value cha và con hợp lý; không có nút đen/hình lạ ẩn dưới nền | M | ~5 |
| V-06 | Scroll-to-top (cuộn xuống) | Icon của app xuất hiện, hình tròn có mũi tên bên trong; không chỉ có vòng tròn; không xuất hiện đồng thời với icon của theme gốc | M | ~23 |
| V-07 | Checkbox dạng Checklist | Hình vuông (không thành chữ nhật); checkbox + tên value + count cùng một dòng, không wrap | M | |
| V-08 | Filter by, Sort by và ô dropdown Sort | Cùng một dòng, không lệch (nhất là Sort bay lên cao); không mất chữ "Sort by"; không có "2 nền trắng" hay nền dư ở dropdown (Horizontal); dropdown không bị Filter by đè một góc; không đè lên label option | M | ~11 |
| V-09 | Product card có "Choose options" | Mở ra panel option: variant option căn giữa (không align top/trái/phải); 2 nút Add to cart + View full detail không tràn sang card bên cạnh; element bên trong không quá sát; panel không bị trong suốt để lộ ảnh sản phẩm | M | ~12 |
| V-10 | Chọn một filter value dạng Checklist | Ô được chọn bôi đen hoặc có dấu tích (không để trắng tinh) | C | ~34 (phổ biến nhất) |
| V-11 | Chip value đã chọn ("Availability: In Stock") | Căn giữa, thẳng hàng với text option; không bay lên trên; có icon X trên chip đã chọn và không lệch | M | ~3 |
| V-12 | Mọi icon của app (dropdown, kính lúp, X) | Không bị phóng to, không biến thành icon đen/hình lạ | M | |
| V-13 | Tick/untick value và 0 selected | Hiển thị "0 selected" không sát lề (Horizontal) | m | |

### B2. Chỉ riêng Off-canvas (desktop) và Mobile
| ID | Kiểm tra | Kỳ vọng | Sev | Tần suất |
|---|---|---|---|---|
| O-01 | Nút "Filter by" (bên trái) | Có icon đúng, icon và chữ không lệch nhau, màu chữ khi focus đúng | M | |
| O-02 | Drawer bên phải mở khi bấm Filter by | Mở được, cuộn được bằng chuột (không phải kéo thanh cuộn) | C | |
| O-03 | Nút X đóng drawer | Có hiển thị, đúng size, nằm trong ô, không lệch; ô X hiện | M | ~20 |
| O-04 | Price slider: From / To | Hiện đủ nhãn, không bị cắt thành "…", nhãn không sát ô nhập đến mức che chữ, không bị khuất bởi currency | M | ~3 |

### B3. Mobile (mặc định off-canvas; đặt viewport mobile cho Tab 3)
| ID | Kiểm tra | Kỳ vọng | Sev |
|---|---|---|---|
| M-01 | Nút "Filter and sort" | Có hiển thị; không hiện Filter/Sort gốc của theme cùng lúc (2 cái đó bấm không ra gì) | C |
| M-02 | Drawer Filter and sort | Mở được; X không lệch/mất; option của Sort căn trái (không bị align phải) | M |
| M-03 | Price slider From/To | Như O-04 | M |
| M-04 | Choose options trên card | Như V-09; card không quá sát nhau, panel và nút không tràn sang card bên cạnh | M |
| M-05 | Lặp lại các mục O-01..O-04 | Như off-canvas desktop | M |

### B4. Search suggestion, desktop
| ID | Kiểm tra | Kỳ vọng | Sev | Tần suất |
|---|---|---|---|---|
| S-01 | Bấm icon kính lúp trên header, gõ "3" | Hiện widget của Findter (template riêng) có watermark "Powered by Findter" | C | ~34 (không hiện/không hoạt động) |
| S-02 | Search của theme (search bar) | Vẫn giữ nguyên, hoạt động, không biến mất giữa chừng | C | |
| S-03 | Chỉ một widget | Không hiện đồng thời widget của app và widget/card suggestion của theme | M | ~30 |
| S-04 | Kích thước và vị trí widget | Rộng bằng search bar của theme (không quá dài/quá ngắn), sát đáy search bar (không cách một khoảng, không đè lên search bar, không bị header đè lên, không che đầu kết quả); không bị đẩy lệch sang phải | M | ~8 |
| S-05 | Ổn định | Widget không tự mở rộng/đè lên màn hình; không biến mất khi cuộn lên | M | |

### B5. Search suggestion, mobile
| ID | Kiểm tra | Kỳ vọng | Sev |
|---|---|---|---|
| S-M1 | Mở search trên mobile | Hiện template Findter, luôn có watermark "Powered by Findter" ở đáy | C |
| S-M2 | Chỉ một layout | Không dùng layout search của theme gốc thay thế, không hiện cả hai cùng lúc/đè lên nhau | M |
| S-M3 | Bấm mũi tên "←" cạnh search bar | Có icon "←" hiển thị; bấm quay về trang, không xuất hiện thêm search bar thứ hai của theme | M |
| S-M4 | Search bar trên mobile | Search bar hiện được, không bị ẩn phía sau UI, nhập được | C |

### B6. Kiểm tra chung (máy móc, không cần mắt người)
| ID | Kiểm tra | Sev |
|---|---|---|
| G-01 | Findter khởi động, container hiện, card có ảnh và giá, không ảnh hỏng | C |
| G-02 | Không cuộn ngang trang (desktop và mobile) | M |
| G-03 | Không lỗi JS, không request Findter thất bại | M |
| G-04 | Layout shift và thời gian hiện card đầu tiên | m |
| G-05 | Ảnh so với lần chạy trước khác nhiều | m |

## C. Đối chiếu và thay đổi so với tool hiện tại (`tools/theme-canary/`)

- **Đã có, giữ lại:** G-01..G-05 (một phần), kiểm tra icon kính lúp chồng lên chữ (V-01), mở drawer, search icon, mobile, báo cáo NEW/FIXED, đổi layout qua admin và trả lại.
- **Thiếu, cần thêm:** V-02..V-13 (đo căn chỉnh thẳng hàng, màu hover, checkbox vuông, chọn value ra dấu tích, chip đã chọn), P-01/P-02 (panel compatibility), O-03/O-04 (X và Price slider), S-03..S-05 và S-M1..S-M4 (một widget duy nhất, kích thước/vị trí, "←", watermark), scroll-to-top V-06.
- **Quy trình khác:** Tab 3 lấy từ nút Preview của theme editor (không dùng URL myshopify trực tiếp); sau mỗi lần đổi layout phải reload Tab 3; sau mỗi theme trả layout về Vertical rồi Exit theme editor để sang theme khác; vòng lô 10 theme (xóa 10, cài 10) thay cho giới hạn 20 theme hiện tại; chạy trên cả Staging và Prod; mỗi lỗi phải có ảnh + video.
- **Báo cáo khác:** run sheet từng thẻ (Steps, Expected, Actual, evidence) giống "Watermark Self-test 885", thêm nhóm theo nguyên nhân chung vì khoảng 34 theme dính cùng lỗi count hover, tick, search suggestion.

## D. Nên chốt trước khi build

1. Hai lỗi chiếm gần 60% theme (V-03 count hover, V-10 tick) là lỗi của app, không phải của riêng theme. Nên coi là "lỗi gốc" và báo một lần, không lặp 34 dòng.
2. Cách đo "căn chỉnh/lệch" phải có ngưỡng (ví dụ lệch tâm quá 2px, X nằm ngoài ô). Cần bạn chốt ngưỡng.
3. "Mobile search layout" khác nhau theo theme (đôi khi search nằm trong menu drawer): cần danh sách theme đặc biệt.
4. Mật khẩu tài khoản Google đang nằm trong Google Doc: nên xóa và đổi.
